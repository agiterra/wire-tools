/**
 * SSE worker — runs in a Bun Worker thread, owns the streaming fetch.
 *
 * Why a worker: Bun's streaming fetch (`reader.read()` over an SSE response)
 * starves the main thread's timer queue. Heartbeats, MCP tool dispatch, and
 * any other periodic work get pushed back, sometimes by tens of seconds,
 * which broke the heartbeat → wake-detected → abort cycle (observed
 * 2026-05-06: Brioche, Fondant, Herald all stuck firing wake_detected every
 * ~38s for 18 hours, never letting streamOnce stabilize).
 *
 * Isolating the streaming fetch in a worker thread gives the main event loop
 * its timer queue back. The worker streams; the main thread does everything
 * else (heartbeat, channel handlers, MCP, ack, send_message HTTP).
 *
 * Protocol:
 *   main → worker: {type:"boot", url, agentId, agentName, ccSessionId?, privateKeyB64}
 *   main → worker: {type:"reset"}  // heartbeat saw 403/404 — abort + new session
 *   main → worker: {type:"stop"}
 *
 *   worker → main: {type:"stream_live", sessionId}
 *   worker → main: {type:"stream_dead", reason?}
 *   worker → main: {type:"event", event}     // parsed WireEvent
 *   worker → main: {type:"give_up", reason}  // 10× consecutive 401/403; main should exit
 *   worker → main: {type:"log", level, fields, msg}
 */

import { join } from "path";
import { importPrivateKey, derivePublicKeyB64 } from "./crypto.js";
import { register, connect, disconnect, type WireEvent } from "./http.js";
import { parseSSEChunk } from "./sse.js";
import { retryWithBackoff } from "./reconnect.js";

declare const self: {
  onmessage: ((ev: { data: unknown }) => void) | null;
  postMessage: (msg: unknown) => void;
  close?: () => void;
};

let url = "";
let agentId = "";
let agentName = "";
let ccSessionId: string | undefined;
let signingKey: CryptoKey | null = null;

let sessionId: string | null = null;
let lastEventId: string | null = null;
let abortController: AbortController | null = null;
let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
let interruptReject: ((err: Error) => void) | null = null;
let stopped = false;
let consecutiveAuthFailures = 0;
const MAX_CONSECUTIVE_AUTH_FAILURES = 10;

const WIRE_LOG = join(process.env.HOME ?? "/tmp", ".wire", "wire-connection.jsonl");

function post(msg: unknown): void {
  self.postMessage(msg);
}

function log(level: "debug" | "info" | "warn" | "error" | "fatal", fields: Record<string, unknown>, msg: string): void {
  post({ type: "log", level, fields: { ...fields, agent: agentId, log: WIRE_LOG }, msg });
}

function stringifyErr(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function maybeGiveUp(err: unknown): void {
  const msg = stringifyErr(err);
  const isAuthFailure = /\((401|403)\)/.test(msg);
  if (!isAuthFailure) {
    consecutiveAuthFailures = 0;
    return;
  }
  consecutiveAuthFailures += 1;
  if (consecutiveAuthFailures >= MAX_CONSECUTIVE_AUTH_FAILURES) {
    log("fatal", { event: "auth_give_up", consecutive: consecutiveAuthFailures, lastErr: msg }, "Wire rejected register/connect with 401/403 too many times");
    post({ type: "give_up", reason: msg });
    stopped = true;
  }
}

async function streamOnce(): Promise<void> {
  if (!sessionId) throw new Error("streamOnce called without sessionId");
  log("debug", { event: "sse_connect", session: sessionId }, "SSE_CONNECT");
  const streamUrl = `${url}/agents/${agentId}/stream?session_id=${sessionId}`;
  abortController = new AbortController();
  const headers: Record<string, string> = {
    Accept: "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  };
  if (lastEventId) headers["Last-Event-ID"] = lastEventId;

  const res = await fetch(streamUrl, { signal: abortController.signal, headers });
  if (!res.ok || !res.body) {
    if (res.status === 403 || res.status === 404 || res.status >= 500) {
      sessionId = null;
      lastEventId = null;
    }
    throw new Error(`SSE failed (${res.status})`);
  }

  const reader = res.body.getReader();
  activeReader = reader;
  const decoder = new TextDecoder();
  let buf = "";

  post({ type: "stream_live", sessionId });

  try {
    while (true) {
      // Race the read against an interrupt promise AND a silence timeout.
      // - interruptPromise: reset/stop signals from main thread.
      // - silenceTimeout: ngrok's idle timeout is ~256s; after a server-side
      //   close, Bun's reader.read() does NOT reliably surface the drop
      //   (observed: workers stay hung indefinitely with 0 TLS connections,
      //   0 CPU, no log output). The timeout fires at 300s — long enough
      //   that any healthy connection will have received SOMETHING (event,
      //   keepalive, anything) before then, but short enough that the
      //   silent-disconnect failure mode is caught within ~44s of ngrok
      //   tearing the connection down.
      const interruptPromise = new Promise<never>((_, reject) => {
        interruptReject = reject;
      });
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error("sse_read_timeout")), 300_000);
      });
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await Promise.race([reader.read(), interruptPromise, timeoutPromise]);
      } finally {
        interruptReject = null;
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }
      const { done, value } = chunk;
      if (done) {
        log("warn", { event: "sse_stream_ended", session: sessionId }, "SSE stream reader returned done=true");
        break;
      }
      buf += decoder.decode(value, { stream: true });
      const { events, remaining } = parseSSEChunk(buf);
      buf = remaining;
      for (const sseEvent of events) {
        if (sseEvent.id) lastEventId = sseEvent.id;
        try {
          const event = JSON.parse(sseEvent.data) as WireEvent;
          post({ type: "event", event });
        } catch (e) {
          log("error", { event: "sse_parse_error", data: sseEvent.data?.slice(0, 200), err: stringifyErr(e) }, "SSE_PARSE_ERROR");
        }
      }
    }
  } finally {
    abortController = null;
    activeReader = null;
    interruptReject = null;
    try { reader.releaseLock(); } catch {}
  }
}

async function reregisterAndReconnect(): Promise<void> {
  await retryWithBackoff(
    async () => {
      if (!signingKey) throw new Error("no signing key");
      const pubB64 = await derivePublicKeyB64(signingKey);
      await register(url, agentId, agentId, agentName, pubB64, signingKey).then(
        () => { consecutiveAuthFailures = 0; },
        (e) => {
          log("error", { event: "register_retry_failed", err: stringifyErr(e) }, "REGISTER_RETRY_FAILED");
          maybeGiveUp(e);
          throw e;
        },
      );
      if (!sessionId) {
        sessionId = await connect(url, agentId, signingKey, ccSessionId);
      }
    },
    {
      shouldStop: () => stopped,
      onError: (e, ms) => log("error", { event: "reconnect_retry", err: stringifyErr(e), backoffMs: ms }, `Wire reconnect failed: ${e}; retrying in ${ms}ms`),
    },
  );
}

async function streamLoop(): Promise<void> {
  let backoff = 1000;
  while (!stopped) {
    try {
      await streamOnce();
      if (stopped) return;
      // Stream ended cleanly — server likely restarted. Clear session for fresh connect.
      log("warn", { event: "sse_stream_exited" }, "stream ended, clearing session for reconnect");
      sessionId = null;
      backoff = 1000;
    } catch (e) {
      if (stopped) return;
      log("error", { event: "sse_error", err: stringifyErr(e), backoff }, "SSE error, reconnecting");
    }

    post({ type: "stream_dead" });
    await new Promise((r) => setTimeout(r, backoff));
    // Exponential backoff capped at 30s (was previously jumping to 15min after
    // exhausting fast retries — recovery from a brief ngrok blip took 15+ min).
    backoff = Math.min(backoff * 2, 30000);
    if (stopped) return;

    await reregisterAndReconnect();
  }
}

async function boot(msg: { url: string; agentId: string; agentName: string; ccSessionId?: string; privateKeyB64: string }): Promise<void> {
  url = msg.url;
  agentId = msg.agentId;
  agentName = msg.agentName;
  ccSessionId = msg.ccSessionId;
  signingKey = await importPrivateKey(msg.privateKeyB64);

  // Initial register + connect — same retry-with-backoff as streamLoop's
  // mid-stream reconnect path. Worker stays alive even on cold-boot failures
  // until the give-up gate fires.
  await retryWithBackoff(
    async () => {
      if (!signingKey) throw new Error("no signing key");
      const pubB64 = await derivePublicKeyB64(signingKey);
      await register(url, agentId, agentId, agentName, pubB64, signingKey).then(
        () => { consecutiveAuthFailures = 0; },
        (e) => {
          log("error", { event: "register_retry_failed", err: stringifyErr(e) }, "REGISTER_RETRY_FAILED");
          maybeGiveUp(e);
          throw e;
        },
      );
      sessionId = await connect(url, agentId, signingKey, ccSessionId);
    },
    {
      shouldStop: () => stopped,
      onError: (e, ms) => log("error", { event: "startup_retry", err: stringifyErr(e), backoffMs: ms }, `Wire startup failed: ${e}; retrying in ${ms}ms`),
    },
  );

  if (stopped) return;
  await streamLoop();

  // Clean exit: send disconnect HTTP and let the main thread terminate the worker.
  if (sessionId && signingKey) {
    try { await disconnect(url, agentId, sessionId, signingKey); } catch {}
    sessionId = null;
  }
}

self.onmessage = (ev) => {
  const data = ev.data as { type?: string } & Record<string, unknown>;
  if (data?.type === "boot") {
    void boot(data as Parameters<typeof boot>[0]).catch((e) => {
      log("fatal", { event: "worker_boot_fatal", err: stringifyErr(e) }, "worker boot crashed");
      post({ type: "give_up", reason: stringifyErr(e) });
    });
  } else if (data?.type === "reset") {
    // Main thread saw heartbeat fail with 403/404 — our session is stale.
    // Abort the current SSE read (which is hung on a zombie TCP socket) and
    // clear sessionId so streamLoop's next iteration calls connect() for a
    // fresh session.
    //
    // Three mechanisms for unblocking the read, in order of escalation:
    //   1. abortController.abort()    — signals fetch to abort (Bun: unreliable)
    //   2. activeReader.cancel()      — releases the lock, signals upstream
    //   3. interruptReject(...)       — Promise.race rejects in streamOnce
    //
    // We do all three because v2.3.2 shipped only (1) and the worker stayed
    // hung indefinitely — the reader.read() promise never resolved/rejected.
    log("warn", { event: "sse_reset_requested", session: sessionId }, "main signaled session reset");
    sessionId = null;
    lastEventId = null;
    abortController?.abort();
    activeReader?.cancel().catch(() => {});
    interruptReject?.(new Error("sse_reset"));
  } else if (data?.type === "stop") {
    stopped = true;
    abortController?.abort();
    activeReader?.cancel().catch(() => {});
    interruptReject?.(new Error("sse_stop"));
  }
};
