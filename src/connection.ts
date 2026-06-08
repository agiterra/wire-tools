/**
 * WireConnection — stateful connection to a Wire server.
 *
 * Composes the stateless tools (crypto, http, sse, reconnect) into the
 * standard Wire protocol lifecycle, plus an inbound message pipeline:
 *
 *   SSE event → channel handler → enrichment pipeline → deliver
 *
 * Architecture (v2.3.1+ on Bun, v2.3.5+ adds Node fallback):
 *
 *   [Worker thread or inline]           [Main thread]
 *   SseRunner                           WireConnection
 *   - register / connect                - heartbeatLoop (timer queue is
 *   - streaming fetch (SSE)               not starved by streaming fetch)
 *   - parseSSE                          - channel handlers
 *   - reconnect / backoff               - enrichment pipelines
 *                                       - send_message / set_plan / ack HTTP
 *
 *   ⇄ postMessage protocol (Bun) / direct callback (Node):
 *     main → driver:  {type:"boot"|"reset"|"stop", ...}
 *     driver → main:  {type:"stream_live"|"stream_dead"|"event"|"give_up"|"log"}
 *
 * Under Bun, the driver is a real Bun Worker (sse-worker.ts) — required to
 * keep the streaming fetch from starving the main event loop. Under Node,
 * `Worker` is not a global; we instead run an SseRunner inline (Node's
 * fetch doesn't have Bun's event-loop-starvation issue, so the worker
 * isolation isn't needed).
 *
 * Adapter authors use this as their main interface. Channel plugins
 * (IPC, Slack, etc.) register handlers. Enrichment stages are configured
 * by the agent.
 */

import { join } from "path";
import { createLogger, type Logger } from "./logger.js";
import { exportPrivateKey } from "./crypto.js";
import {
  ack as ackHttp,
  heartbeat as heartbeatHttp,
  type WireEvent,
} from "./http.js";

const WIRE_LOG = join(process.env.HOME ?? "/tmp", ".wire", "wire-connection.jsonl");

const connectionLogger = createLogger("wire-connection", WIRE_LOG);

export type { WireEvent };

// --- Channel handler types ---

export type ChannelResult = {
  text: string;
  metadata: Record<string, unknown>;
};

export type ChannelHandler = {
  /** Process a raw Wire event into a ChannelResult. */
  process: (
    payload: unknown,
    validatorResult: unknown,
  ) => ChannelResult | null;
};

// --- Enrichment types ---

export type EnrichmentResult = {
  source: string; // e.g. "personai://vault/memory/project.md", "slack://history/C0ADW24BYJV"
  content: string;
  score: number;
  metadata?: Record<string, unknown>;
};

export type EnrichmentContext = {
  channel: ChannelResult;
  raw: WireEvent;
  prior: EnrichmentResult[];
};

export type Enricher = (ctx: EnrichmentContext) => Promise<EnrichmentResult[]>;

// --- Delivery types ---

export type DeliveryPayload = {
  raw: WireEvent;
  channel: ChannelResult;
  enrichment: EnrichmentResult[];
};

export type DeliverFn = (payload: DeliveryPayload) => void | Promise<void>;

// --- Connection options ---

export type ConnectionOptions = {
  url: string;
  agentId: string;
  agentName: string;
  ccSessionId?: string; // Identifies the Claude Code session (survives SSE reconnects)
  keyPair: { publicKey: string; privateKey: CryptoKey }; // Caller provides the key
  heartbeatInterval?: number; // ms, default 10000
  workerWatchdogMs?: number; // ms; respawn the Bun SSE worker after this much silence (no liveness ping). Default 90000.
  deliver: DeliverFn;
  onError?: (error: unknown) => void;
  onConnect?: (sessionId: string) => void;
  onDisconnect?: () => void;
};

// --- Driver protocol types ---

type DriverToMainMsg =
  | { type: "stream_live"; sessionId: string }
  | { type: "stream_dead"; reason?: string }
  | { type: "event"; event: WireEvent }
  | { type: "give_up"; reason: string }
  | { type: "alive" }
  | { type: "log"; level: "debug" | "info" | "warn" | "error" | "fatal"; fields: Record<string, unknown>; msg: string };

type BootMsg = {
  type: "boot";
  url: string;
  agentId: string;
  agentName: string;
  ccSessionId?: string;
  privateKeyB64: string;
};

// Parent-thread liveness watchdog (Bun Worker path only). The worker posts
// {type:"alive"} every 15s; if its event loop freezes on Bun's silent-server-
// close fetch hang, those stop. We respawn the worker after WATCHDOG_SILENCE_MS
// of total silence — the durable fix for the 2026-06-05 "agent went Wire-dark
// for 2.75 days, no auto-reconnect" failure (a frozen worker can't run its own
// read-timeout; only the parent, on a separate thread, can see + recover it).
const WATCHDOG_SILENCE_MS = 90_000;
const WATCHDOG_CHECK_MS = 30_000;

// Minimal shape of either a Bun Worker or an inline-SseRunner adapter.
interface SseDriver {
  postMessage(msg: unknown): void;
  terminate(): void;
}

export class WireConnection {
  private opts: ConnectionOptions;
  private signingKey: CryptoKey | null = null;
  private sessionId: string | null = null;
  private streamLive = false;
  private stopped = false;
  private log: Logger;

  private driver: SseDriver | null = null;
  // For the Node inline path: a promise that resolves when the SseRunner
  // boot loop has fully exited (clean disconnect HTTP sent). stop() awaits
  // this for symmetry with the Bun worker's 500ms grace.
  private driverDone: Promise<void> | null = null;
  // Watchdog state (Bun Worker path only): the boot message to replay on a
  // respawn, the timestamp of the last message received FROM the driver, and
  // the periodic check timer.
  private bootMsg: BootMsg | null = null;
  private lastDriverMsgAt = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private bootResolve: ((sessionId: string) => void) | null = null;
  private bootReject: ((err: Error) => void) | null = null;

  // Channel handler registry: topic pattern → handler
  private channelHandlers = new Map<string, ChannelHandler>();

  // Enrichment pipelines: channel name (topic pattern) → ordered enrichers
  private enrichmentPipelines = new Map<string, Enricher[]>();

  constructor(opts: ConnectionOptions) {
    this.opts = opts;
    this.log = connectionLogger.child({ agent: opts.agentId });
  }

  get agentId(): string {
    return this.opts.agentId;
  }

  get url(): string {
    return this.opts.url;
  }

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  get key(): CryptoKey | null {
    return this.signingKey;
  }

  // --- Channel handler registration ---

  /**
   * Register a channel handler for a topic pattern.
   * The handler processes raw Wire events into ChannelResult.
   */
  registerChannel(topic: string, handler: ChannelHandler): void {
    this.channelHandlers.set(topic, handler);
  }

  // --- Enrichment pipeline configuration ---

  /**
   * Set the enrichment pipeline for a channel topic.
   * Stages run in order; each sees the prior stages' results.
   */
  setEnrichmentPipeline(topic: string, enrichers: Enricher[]): void {
    this.enrichmentPipelines.set(topic, enrichers);
  }

  // --- Lifecycle ---

  async start(): Promise<void> {
    this.stopped = false;
    this.signingKey = this.opts.keyPair.privateKey;

    // The streaming fetch lives in a separate driver (Bun Worker thread on
    // Bun, inline SseRunner on Node) so it can't starve our timer queue
    // (heartbeats, MCP dispatch, etc.) on the runtimes where that matters.
    // We pass the private key as PKCS8 base64 since CryptoKey is not
    // structuredClone-able through Worker postMessage.
    const privateKeyB64 = await exportPrivateKey(this.signingKey);

    const bootMsg = {
      type: "boot" as const,
      url: this.opts.url,
      agentId: this.opts.agentId,
      agentName: this.opts.agentName,
      ccSessionId: this.opts.ccSessionId,
      privateKeyB64,
    };

    // Boot promise: resolves on first stream_live, rejects on give_up.
    const bootDone = new Promise<string>((resolve, reject) => {
      this.bootResolve = resolve;
      this.bootReject = reject;
    });

    if (typeof Worker !== "undefined") {
      // Bun (or any runtime with the Web Worker API) — isolate the streaming
      // fetch in a Worker thread. The 2026-05-07 bug was Bun-specific event-
      // loop starvation; this is the durable fix for that case.
      this.bootMsg = bootMsg;
      this.spawnWorker();
    } else {
      // Node / tsx — no global Worker. Run the SseRunner inline on the main
      // thread. Node's fetch doesn't block the event loop the way Bun's does
      // (undici reads from the socket via libuv I/O threads), so the worker
      // isolation isn't required here. Without this branch, `new Worker(...)`
      // throws `ReferenceError: Worker is not defined` and the wire MCP
      // child crashes 2s after MCP handshake (wire-codex on codex 0.125,
      // observed 2026-05-11 — agents appeared grey on the dashboard because
      // the MCP died before heartbeat could fire).
      const { SseRunner } = await import("./sse-runner.js");
      const runner = new SseRunner((msg) => this.handleWorkerMessage(msg as DriverToMainMsg));
      this.driverDone = runner.boot(bootMsg);
      this.driver = {
        postMessage: (msg: unknown) => {
          const m = msg as { type?: string };
          if (m?.type === "reset") runner.reset();
          else if (m?.type === "stop") runner.stop();
          // type==="boot" is already initiated above; ignore re-send.
        },
        terminate: () => runner.stop(),
      };
    }

    await bootDone;

    // Bun Worker path only: start the parent-thread liveness watchdog now that
    // the worker is connected. The Node inline path can't freeze the same way
    // and has no worker to respawn, so it's skipped.
    if (typeof Worker !== "undefined") this.startWatchdog();

    // Heartbeat lives on the main thread now. Its setTimeout queue is no
    // longer starved by streaming fetch in this thread, so it ticks reliably
    // every intervalMs.
    this.heartbeatLoop(this.opts.heartbeatInterval ?? 10_000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearWatchdog();
    if (this.driver) {
      this.driver.postMessage({ type: "stop" });
      if (this.driverDone) {
        // Inline path — await the runner's clean exit (disconnect HTTP sent
        // inside boot()). Cap the wait so we don't block shutdown forever.
        await Promise.race([
          this.driverDone,
          new Promise((r) => setTimeout(r, 1500)),
        ]);
      } else {
        // Worker path — give it the same 500ms grace as v2.3.x.
        await new Promise((r) => setTimeout(r, 500));
      }
      this.driver.terminate();
      this.driver = null;
      this.driverDone = null;
    }
    this.streamLive = false;
    this.sessionId = null;
  }

  // --- Bun SSE worker spawn + liveness watchdog ---

  /**
   * Spawn (or respawn) the Bun SSE worker from the stored boot message and wire
   * up its message/error handlers. Resets the watchdog clock so the fresh
   * worker gets a full silence window to boot + connect.
   */
  private spawnWorker(): void {
    if (!this.bootMsg) return;
    const w = new Worker(new URL("./sse-worker.ts", import.meta.url).href);
    w.onmessage = (ev: MessageEvent<DriverToMainMsg>) => this.handleWorkerMessage(ev.data);
    w.onerror = (ev: ErrorEvent) => {
      this.log.error({ event: "worker_error", message: ev.message, filename: ev.filename, lineno: ev.lineno }, "WORKER_ERROR");
      this.opts.onError?.(new Error(`SSE worker error: ${ev.message}`));
    };
    w.postMessage(this.bootMsg);
    this.driver = w as unknown as SseDriver;
    this.lastDriverMsgAt = Date.now();
  }

  /**
   * Parent-thread liveness watchdog. The worker posts {type:"alive"} every 15s;
   * if its event loop freezes on Bun's silent-server-close fetch hang those
   * stop (even the in-worker read-timeout can't fire on a frozen loop). After
   * WATCHDOG_SILENCE_MS with NO driver message, terminate + respawn the worker —
   * the fresh worker re-registers, reconnects, and replays from last_ack. This
   * is the recovery the 2026-06-05 2.75-day Wire-dark hang lacked.
   */
  private startWatchdog(): void {
    this.clearWatchdog();
    this.lastDriverMsgAt = Date.now();
    const silenceMs = this.opts.workerWatchdogMs ?? WATCHDOG_SILENCE_MS;
    // Check a few times per silence window (>=50ms floor so tests stay fast).
    const checkMs = Math.min(WATCHDOG_CHECK_MS, Math.max(50, Math.floor(silenceMs / 3)));
    this.watchdog = setInterval(() => {
      if (this.stopped || !this.driver) return;
      const silentMs = Date.now() - this.lastDriverMsgAt;
      if (silentMs <= silenceMs) return;
      this.log.error(
        { event: "sse_worker_dark", silentMs },
        `SSE worker silent ${Math.round(silentMs / 1000)}s — respawning frozen worker`,
      );
      this.streamLive = false;
      try { this.driver.terminate(); } catch { /* already dead */ }
      this.driver = null;
      this.spawnWorker();
    }, checkMs);
  }

  private clearWatchdog(): void {
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
  }

  // --- Driver message dispatch (Bun worker or inline SseRunner) ---

  private handleWorkerMessage(msg: DriverToMainMsg): void {
    // Any message from the driver — including the periodic {type:"alive"} ping —
    // is proof the worker's event loop is running. Feeds the watchdog.
    this.lastDriverMsgAt = Date.now();
    switch (msg.type) {
      case "alive":
        return;
      case "stream_live": {
        const wasFirstConnect = this.bootResolve != null;
        this.sessionId = msg.sessionId;
        this.streamLive = true;
        if (this.bootResolve) {
          this.bootResolve(msg.sessionId);
          this.bootResolve = null;
          this.bootReject = null;
        }
        if (!wasFirstConnect) {
          this.log.info({ event: "stream_live", session: msg.sessionId }, "stream live (reconnected)");
        }
        this.opts.onConnect?.(msg.sessionId);
        break;
      }
      case "stream_dead": {
        this.streamLive = false;
        this.opts.onDisconnect?.();
        break;
      }
      case "event": {
        void this.handleEvent(msg.event);
        break;
      }
      case "give_up": {
        this.log.fatal({ event: "auth_give_up", reason: msg.reason }, "Wire rejected register/connect repeatedly — exiting");
        if (this.bootReject) {
          this.bootReject(new Error(`Wire give_up: ${msg.reason}`));
          this.bootResolve = null;
          this.bootReject = null;
        }
        // The orphan-reaper will clean us up; our parent CC will respawn cleanly.
        process.exit(1);
        break;
      }
      case "log": {
        const fn = (this.log as unknown as Record<string, (f: unknown, m: string) => void>)[msg.level]
          ?? this.log.info.bind(this.log);
        fn.call(this.log, msg.fields, msg.msg);
        break;
      }
    }
  }

  // --- Ack ---

  async ack(seq: number): Promise<void> {
    if (!this.sessionId || !this.signingKey) return;
    try {
      await ackHttp(
        this.opts.url,
        this.opts.agentId,
        this.sessionId,
        seq,
        this.signingKey,
      );
    } catch (e) {
      this.opts.onError?.(e);
    }
  }

  // --- Inbound pipeline ---

  private async handleEvent(event: WireEvent): Promise<void> {
    this.log.debug({ event: "recv", seq: event.seq, topic: event.topic, source: event.source }, "RECV");

    // Skip own messages on broadcast — but allow unicast to self
    if (event.source === this.opts.agentId && event.dest !== this.opts.agentId) {
      this.log.debug({ event: "skip", seq: event.seq, reason: "own_broadcast" }, "SKIP");
      this.ack(event.seq);
      return;
    }

    // 1. Find channel handler for this topic
    const handler = this.findChannelHandler(event.topic);
    const validatorResult = this.extractValidatorResult(event);
    this.log.debug({ event: "handler", seq: event.seq, topic: event.topic, found: !!handler }, "HANDLER");

    let channelResult: ChannelResult;
    if (handler) {
      const result = handler.process(event.payload, validatorResult);
      if (!result) {
        this.log.debug({ event: "rejected", seq: event.seq }, "REJECTED");
        this.ack(event.seq);
        return;
      }
      channelResult = result;
      this.log.debug({ event: "processed", seq: event.seq, text: channelResult.text.slice(0, 100) }, "PROCESSED");
    } else {
      // No handler — pass through raw payload as text
      channelResult = {
        text:
          typeof event.payload === "string"
            ? event.payload
            : JSON.stringify(event.payload),
        metadata: { source: event.source, topic: event.topic },
      };
      this.log.debug({ event: "passthrough", seq: event.seq, text: channelResult.text.slice(0, 100) }, "PASSTHROUGH");
    }

    // 2. Run enrichment pipeline
    const enrichers = this.findEnrichmentPipeline(event.topic);
    this.log.debug({ event: "enrich", seq: event.seq, stages: enrichers.length }, "ENRICH");
    let enrichment: EnrichmentResult[] = [];
    for (const enricher of enrichers) {
      try {
        const results = await enricher({
          channel: channelResult,
          raw: event,
          prior: enrichment,
        });
        enrichment = [...enrichment, ...results];
      } catch (e) {
        this.log.error({ event: "enrich_error", seq: event.seq, err: e }, "ENRICH_ERROR");
        this.opts.onError?.(e);
      }
    }

    // 3. Deliver to adapter
    this.log.debug({ event: "deliver", seq: event.seq }, "DELIVER");
    try {
      await this.opts.deliver({ raw: event, channel: channelResult, enrichment });
      this.log.debug({ event: "deliver_ok", seq: event.seq }, "DELIVER_OK");
      this.ack(event.seq);
    } catch (e) {
      this.log.error({ event: "deliver_fail", seq: event.seq, err: e }, "DELIVER_FAIL");
      this.opts.onError?.(e);
    }
  }

  private findChannelHandler(topic: string): ChannelHandler | undefined {
    // Exact match first
    if (this.channelHandlers.has(topic)) {
      return this.channelHandlers.get(topic);
    }
    // Try prefix matching (e.g. "ipc" matches "ipc.something")
    for (const [pattern, handler] of this.channelHandlers) {
      if (topic.startsWith(pattern + ".") || topic === pattern) {
        return handler;
      }
    }
    return undefined;
  }

  private findEnrichmentPipeline(topic: string): Enricher[] {
    if (this.enrichmentPipelines.has(topic)) {
      return this.enrichmentPipelines.get(topic)!;
    }
    for (const [pattern, pipeline] of this.enrichmentPipelines) {
      if (topic.startsWith(pattern + ".") || topic === pattern) {
        return pipeline;
      }
    }
    // Fall back to "*" catch-all if defined
    return this.enrichmentPipelines.get("*") ?? [];
  }

  private extractValidatorResult(event: WireEvent): unknown {
    if (
      typeof event.payload === "object" &&
      event.payload !== null &&
      "validator_result" in (event.payload as Record<string, unknown>)
    ) {
      return (event.payload as Record<string, unknown>).validator_result;
    }
    return undefined;
  }

  // --- Heartbeat (main thread, isolated from streaming fetch) ---

  private async heartbeatLoop(intervalMs: number): Promise<void> {
    this.log.debug({ event: "heartbeat_loop_start", intervalMs }, "heartbeat loop started");
    while (!this.stopped) {
      await new Promise((r) => setTimeout(r, intervalMs));
      if (this.stopped) return;

      // Heartbeat only when the worker reports the SSE stream is live.
      // If the stream is broken (network blip, server restart, worker is in
      // backoff), we let last_heartbeat go stale on the server side so the
      // dashboard reflects un-deliverability honestly. When the worker
      // reconnects and posts stream_live, heartbeat resumes — server's
      // clearReap fires on the next tick and the agent goes green again.
      if (this.sessionId && this.signingKey && this.streamLive) {
        const result = await heartbeatHttp(
          this.opts.url,
          this.opts.agentId,
          this.sessionId,
          this.signingKey,
        );
        if (result.ok) {
          this.log.debug({ event: "heartbeat_ok", session: this.sessionId }, "heartbeat ok");
        } else if (result.sessionInvalid) {
          // Server purged our session (typical after a sleep/wake or any long
          // disconnect: SSE reader hangs on a zombie TCP socket while the
          // server reaper deletes the stale agent_sessions row). The SSE
          // worker can't notice on its own — heartbeat is the canary, so
          // signal it to abort and reconnect with a fresh session.
          this.log.warn(
            { event: "heartbeat_session_invalid", session: this.sessionId, status: result.status },
            "heartbeat session invalid — signaling worker to reconnect",
          );
          this.streamLive = false;
          this.sessionId = null;
          this.driver?.postMessage({ type: "reset" });
        } else {
          this.log.error(
            { event: "heartbeat_error", session: this.sessionId, status: result.status, err: result.err },
            "heartbeat error",
          );
        }
      }
    }
  }
}
