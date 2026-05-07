/**
 * WireConnection — stateful connection to a Wire server.
 *
 * Composes the stateless tools (crypto, http, sse, reconnect) into the
 * standard Wire protocol lifecycle, plus an inbound message pipeline:
 *
 *   SSE event → channel handler → enrichment pipeline → deliver
 *
 * Architecture (v2.3.1+):
 *
 *   [Worker thread]                     [Main thread]
 *   sse-worker.ts                       WireConnection
 *   - register / connect                - heartbeatLoop (timer queue is
 *   - streaming fetch (SSE)               not starved by streaming fetch)
 *   - parseSSE                          - channel handlers
 *   - reconnect / backoff               - enrichment pipelines
 *                                       - send_message / set_plan / ack HTTP
 *
 *   ⇄ postMessage protocol:
 *     main → worker: {type:"boot"|"stop", ...}
 *     worker → main: {type:"stream_live"|"stream_dead"|"event"|"give_up"|"log"}
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
  deliver: DeliverFn;
  onError?: (error: unknown) => void;
  onConnect?: (sessionId: string) => void;
  onDisconnect?: () => void;
};

// --- Worker protocol types ---

type WorkerToMainMsg =
  | { type: "stream_live"; sessionId: string }
  | { type: "stream_dead"; reason?: string }
  | { type: "event"; event: WireEvent }
  | { type: "give_up"; reason: string }
  | { type: "log"; level: "debug" | "info" | "warn" | "error" | "fatal"; fields: Record<string, unknown>; msg: string };

export class WireConnection {
  private opts: ConnectionOptions;
  private signingKey: CryptoKey | null = null;
  private sessionId: string | null = null;
  private streamLive = false;
  private stopped = false;
  private log: Logger;

  private worker: Worker | null = null;
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

    // The streaming fetch lives in a worker so it can't starve our timer
    // queue (heartbeats, MCP dispatch, etc.). We pass the private key as
    // PKCS8 base64 since CryptoKey is not structuredClone-able.
    const privateKeyB64 = await exportPrivateKey(this.signingKey);

    this.worker = new Worker(new URL("./sse-worker.ts", import.meta.url).href);
    this.worker.onmessage = (ev: MessageEvent<WorkerToMainMsg>) => this.handleWorkerMessage(ev.data);
    this.worker.onerror = (ev: ErrorEvent) => {
      this.log.error({ event: "worker_error", message: ev.message, filename: ev.filename, lineno: ev.lineno }, "WORKER_ERROR");
      this.opts.onError?.(new Error(`SSE worker error: ${ev.message}`));
    };

    // Boot promise: resolves on first stream_live, rejects on give_up.
    const bootDone = new Promise<string>((resolve, reject) => {
      this.bootResolve = resolve;
      this.bootReject = reject;
    });

    this.worker.postMessage({
      type: "boot",
      url: this.opts.url,
      agentId: this.opts.agentId,
      agentName: this.opts.agentName,
      ccSessionId: this.opts.ccSessionId,
      privateKeyB64,
    });

    await bootDone;

    // Heartbeat lives on the main thread now. Its setTimeout queue is no
    // longer starved by streaming fetch in this thread, so it ticks reliably
    // every intervalMs.
    this.heartbeatLoop(this.opts.heartbeatInterval ?? 10_000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.worker) {
      this.worker.postMessage({ type: "stop" });
      // Give worker a moment to send disconnect HTTP and exit cleanly.
      await new Promise((r) => setTimeout(r, 500));
      this.worker.terminate();
      this.worker = null;
    }
    this.streamLive = false;
    this.sessionId = null;
  }

  // --- Worker message dispatch ---

  private handleWorkerMessage(msg: WorkerToMainMsg): void {
    switch (msg.type) {
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
        try {
          await heartbeatHttp(
            this.opts.url,
            this.opts.agentId,
            this.sessionId,
            this.signingKey,
          );
          this.log.debug({ event: "heartbeat_ok", session: this.sessionId }, "heartbeat ok");
        } catch (e) {
          this.log.error({ event: "heartbeat_error", session: this.sessionId, err: e }, "heartbeat error");
        }
      }
    }
  }
}
