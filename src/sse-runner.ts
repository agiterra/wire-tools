/**
 * SSE runner — register/connect/streamOnce/streamLoop/reconnect logic that
 * can run EITHER in a Bun Worker thread (isolated from the main event loop)
 * OR inline on the main thread under Node.
 *
 * Why both: Bun's streaming fetch (`await reader.read()`) blocks the entire
 * event loop while chunks are arriving — timers, MCP stdio, heartbeat HTTP
 * all stall. Under Bun we isolate the streaming fetch in a Worker so the
 * main thread's event loop stays responsive (see j:7 + commit b9792df).
 * Under Node, `fetch` (undici) reads from the socket via libuv I/O threads
 * and `await reader.read()` yields to the event loop between chunks — the
 * Bun starvation bug doesn't reproduce, so a worker isn't necessary and
 * shouldn't be required: tsx/Node has no Web Worker global, so attempting
 * `new Worker()` under it crashed wire-codex MCP children with
 * `ReferenceError: Worker is not defined` 2s after MCP handshake (2026-05-11).
 *
 * Architecture:
 *   - SseRunner encapsulates all SSE-loop state in a single instance.
 *   - Bun path: sse-worker.ts (thin Worker entry) instantiates one SseRunner
 *     wired to `self.postMessage` and dispatches `self.onmessage` to its
 *     methods.
 *   - Node path: connection.ts instantiates one SseRunner directly, passing
 *     `handleWorkerMessage` as the post callback.
 *
 * The post protocol is identical in both modes — connection.ts's switch
 * statement sees the same messages from either runtime.
 */

import { join } from "path";
import { importPrivateKey, derivePublicKeyB64 } from "./crypto.js";
import { register, connect, disconnect, type WireEvent } from "./http.js";
import { parseSSEChunk } from "./sse.js";
import { retryWithBackoff } from "./reconnect.js";

const WIRE_LOG = join(process.env.HOME ?? "/tmp", ".wire", "wire-connection.jsonl");

const MAX_CONSECUTIVE_AUTH_FAILURES = 10;

export type SseRunnerBootMsg = {
  url: string;
  agentId: string;
  agentName: string;
  ccSessionId?: string;
  privateKeyB64: string;
};

export type SseRunnerOutMsg =
  | { type: "stream_live"; sessionId: string }
  | { type: "stream_dead"; reason?: string }
  | { type: "event"; event: WireEvent }
  | { type: "give_up"; reason: string }
  | { type: "log"; level: "debug" | "info" | "warn" | "error" | "fatal"; fields: Record<string, unknown>; msg: string };

type PostFn = (msg: SseRunnerOutMsg) => void;

function stringifyErr(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export class SseRunner {
  private url = "";
  private agentId = "";
  private agentName = "";
  private ccSessionId: string | undefined;
  private signingKey: CryptoKey | null = null;

  private sessionId: string | null = null;
  private lastEventId: string | null = null;
  private abortController: AbortController | null = null;
  private activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private interruptReject: ((err: Error) => void) | null = null;
  private stopped = false;
  private consecutiveAuthFailures = 0;

  private bootPromise: Promise<void> | null = null;

  constructor(private post: PostFn) {}

  /** Has boot() completed (cleanly or otherwise)? Used by inline mode to
   *  await graceful exit on stop(). */
  get done(): Promise<void> {
    return this.bootPromise ?? Promise.resolve();
  }

  private log(level: "debug" | "info" | "warn" | "error" | "fatal", fields: Record<string, unknown>, msg: string): void {
    this.post({ type: "log", level, fields: { ...fields, agent: this.agentId, log: WIRE_LOG }, msg });
  }

  private maybeGiveUp(err: unknown): void {
    const msg = stringifyErr(err);
    const isAuthFailure = /\((401|403)\)/.test(msg);
    if (!isAuthFailure) {
      this.consecutiveAuthFailures = 0;
      return;
    }
    this.consecutiveAuthFailures += 1;
    if (this.consecutiveAuthFailures >= MAX_CONSECUTIVE_AUTH_FAILURES) {
      this.log("fatal", { event: "auth_give_up", consecutive: this.consecutiveAuthFailures, lastErr: msg }, "Wire rejected register/connect with 401/403 too many times");
      this.post({ type: "give_up", reason: msg });
      this.stopped = true;
    }
  }

  private async streamOnce(): Promise<void> {
    if (!this.sessionId) throw new Error("streamOnce called without sessionId");
    this.log("debug", { event: "sse_connect", session: this.sessionId }, "SSE_CONNECT");
    const streamUrl = `${this.url}/agents/${this.agentId}/stream?session_id=${this.sessionId}`;
    this.abortController = new AbortController();
    const headers: Record<string, string> = {
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    };
    if (this.lastEventId) headers["Last-Event-ID"] = this.lastEventId;

    const res = await fetch(streamUrl, { signal: this.abortController.signal, headers });
    if (!res.ok || !res.body) {
      if (res.status === 403 || res.status === 404 || res.status >= 500) {
        this.sessionId = null;
        this.lastEventId = null;
      }
      throw new Error(`SSE failed (${res.status})`);
    }

    const reader = res.body.getReader();
    this.activeReader = reader;
    const decoder = new TextDecoder();
    let buf = "";

    this.post({ type: "stream_live", sessionId: this.sessionId });

    try {
      while (true) {
        // Race the read against an interrupt promise AND a silence timeout.
        // - interruptPromise: reset/stop signals.
        // - silenceTimeout: ngrok's idle timeout is ~256s; after a server-side
        //   close, Bun's reader.read() does NOT reliably surface the drop
        //   (observed: workers stay hung indefinitely with 0 TLS connections,
        //   0 CPU, no log output). The timeout fires at 300s — long enough
        //   that any healthy connection will have received SOMETHING (event,
        //   keepalive, anything) before then, but short enough that the
        //   silent-disconnect failure mode is caught within ~44s of ngrok
        //   tearing the connection down.
        const interruptPromise = new Promise<never>((_, reject) => {
          this.interruptReject = reject;
        });
        let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error("sse_read_timeout")), 300_000);
        });
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await Promise.race([reader.read(), interruptPromise, timeoutPromise]);
        } finally {
          this.interruptReject = null;
          if (timeoutHandle) clearTimeout(timeoutHandle);
        }
        const { done, value } = chunk;
        if (done) {
          this.log("warn", { event: "sse_stream_ended", session: this.sessionId }, "SSE stream reader returned done=true");
          break;
        }
        buf += decoder.decode(value, { stream: true });
        const { events, remaining } = parseSSEChunk(buf);
        buf = remaining;
        for (const sseEvent of events) {
          if (sseEvent.id) this.lastEventId = sseEvent.id;
          try {
            const event = JSON.parse(sseEvent.data) as WireEvent;
            this.post({ type: "event", event });
          } catch (e) {
            this.log("error", { event: "sse_parse_error", data: sseEvent.data?.slice(0, 200), err: stringifyErr(e) }, "SSE_PARSE_ERROR");
          }
        }
      }
    } finally {
      this.abortController = null;
      this.activeReader = null;
      this.interruptReject = null;
      try { reader.releaseLock(); } catch {}
    }
  }

  private async reregisterAndReconnect(): Promise<void> {
    await retryWithBackoff(
      async () => {
        if (!this.signingKey) throw new Error("no signing key");
        const pubB64 = await derivePublicKeyB64(this.signingKey);
        await register(this.url, this.agentId, this.agentId, this.agentName, pubB64, this.signingKey).then(
          () => { this.consecutiveAuthFailures = 0; },
          (e) => {
            this.log("error", { event: "register_retry_failed", err: stringifyErr(e) }, "REGISTER_RETRY_FAILED");
            this.maybeGiveUp(e);
            throw e;
          },
        );
        if (!this.sessionId) {
          this.sessionId = await connect(this.url, this.agentId, this.signingKey, this.ccSessionId);
        }
      },
      {
        shouldStop: () => this.stopped,
        onError: (e, ms) => this.log("error", { event: "reconnect_retry", err: stringifyErr(e), backoffMs: ms }, `Wire reconnect failed: ${e}; retrying in ${ms}ms`),
      },
    );
  }

  private async streamLoop(): Promise<void> {
    let backoff = 1000;
    while (!this.stopped) {
      try {
        await this.streamOnce();
        if (this.stopped) return;
        // Stream ended cleanly — server likely restarted. Clear session for fresh connect.
        this.log("warn", { event: "sse_stream_exited" }, "stream ended, clearing session for reconnect");
        this.sessionId = null;
        backoff = 1000;
      } catch (e) {
        if (this.stopped) return;
        this.log("error", { event: "sse_error", err: stringifyErr(e), backoff }, "SSE error, reconnecting");
      }

      this.post({ type: "stream_dead" });
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30000);
      if (this.stopped) return;

      await this.reregisterAndReconnect();
    }
  }

  /**
   * Run the full register → connect → streamLoop lifecycle.
   * Returns when stopped (clean exit) or when the give-up gate fires.
   */
  boot(msg: SseRunnerBootMsg): Promise<void> {
    if (this.bootPromise) return this.bootPromise;
    this.bootPromise = this.runBoot(msg).catch((e) => {
      this.log("fatal", { event: "worker_boot_fatal", err: stringifyErr(e) }, "sse runner boot crashed");
      this.post({ type: "give_up", reason: stringifyErr(e) });
    });
    return this.bootPromise;
  }

  private async runBoot(msg: SseRunnerBootMsg): Promise<void> {
    this.url = msg.url;
    this.agentId = msg.agentId;
    this.agentName = msg.agentName;
    this.ccSessionId = msg.ccSessionId;
    this.signingKey = await importPrivateKey(msg.privateKeyB64);

    await retryWithBackoff(
      async () => {
        if (!this.signingKey) throw new Error("no signing key");
        const pubB64 = await derivePublicKeyB64(this.signingKey);
        await register(this.url, this.agentId, this.agentId, this.agentName, pubB64, this.signingKey).then(
          () => { this.consecutiveAuthFailures = 0; },
          (e) => {
            this.log("error", { event: "register_retry_failed", err: stringifyErr(e) }, "REGISTER_RETRY_FAILED");
            this.maybeGiveUp(e);
            throw e;
          },
        );
        this.sessionId = await connect(this.url, this.agentId, this.signingKey, this.ccSessionId);
      },
      {
        shouldStop: () => this.stopped,
        onError: (e, ms) => this.log("error", { event: "startup_retry", err: stringifyErr(e), backoffMs: ms }, `Wire startup failed: ${e}; retrying in ${ms}ms`),
      },
    );

    if (this.stopped) return;
    await this.streamLoop();

    // Clean exit: send disconnect HTTP. The Worker case relies on the main
    // thread terminating us; the inline case lets boot() return naturally.
    if (this.sessionId && this.signingKey) {
      try { await disconnect(this.url, this.agentId, this.sessionId, this.signingKey); } catch {}
      this.sessionId = null;
    }
  }

  /**
   * Heartbeat saw 403/404 — our session is stale.
   * Abort the current SSE read (hung on a zombie TCP socket) and clear
   * sessionId so streamLoop's next iteration calls connect() for a fresh
   * session.
   *
   * Three mechanisms for unblocking the read, in order of escalation:
   *   1. abortController.abort()    — signals fetch to abort (Bun: unreliable)
   *   2. activeReader.cancel()      — releases the lock, signals upstream
   *   3. interruptReject(...)       — Promise.race rejects in streamOnce
   *
   * v2.3.2 shipped only (1) and the worker stayed hung — reader.read() never
   * resolved/rejected. All three are needed.
   */
  reset(): void {
    this.log("warn", { event: "sse_reset_requested", session: this.sessionId }, "main signaled session reset");
    this.sessionId = null;
    this.lastEventId = null;
    this.abortController?.abort();
    this.activeReader?.cancel().catch(() => {});
    this.interruptReject?.(new Error("sse_reset"));
  }

  /** Stop the loop. Inline callers should `await this.done` for clean exit. */
  stop(): void {
    this.stopped = true;
    this.abortController?.abort();
    this.activeReader?.cancel().catch(() => {});
    this.interruptReject?.(new Error("sse_stop"));
  }
}
