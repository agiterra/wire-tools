/**
 * WireConnection — stateful connection to a Wire server.
 *
 * Composes the stateless tools (crypto, http, sse, reconnect) into the
 * standard Wire protocol lifecycle, plus an inbound message pipeline:
 *
 *   SSE event → channel handler → enrichment pipeline → deliver
 *
 * Adapter authors use this as their main interface. Channel plugins
 * (IPC, Slack, etc.) register handlers. Enrichment stages are configured
 * by the agent.
 */

import { join } from "path";
import { createLogger, type Logger } from "./logger.js";
import { loadOrCreateKey, derivePublicKeyB64 } from "./crypto.js";
import {
  register,
  connect,
  disconnect,
  ack as ackHttp,
  heartbeat as heartbeatHttp,
  type WireEvent,
} from "./http.js";
import { parseSSEChunk } from "./sse.js";
import { retryWithBackoff } from "./reconnect.js";

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
  subscriptions?: string[];
  heartbeatInterval?: number; // ms, default 20000
  deliver: DeliverFn;
  onError?: (error: unknown) => void;
  onConnect?: (sessionId: string) => void;
  onDisconnect?: () => void;
};

export class WireConnection {
  private opts: ConnectionOptions;
  private signingKey: CryptoKey | null = null;
  private publicKey: string | null = null;
  private sessionId: string | null = null;
  private abortController: AbortController | null = null;
  private stopped = false;
  private log: Logger;

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
    const kp = await loadOrCreateKey(this.opts.agentId);
    this.signingKey = kp.privateKey;
    this.publicKey = kp.publicKey;

    await retryWithBackoff(
      async () => {
        await register(
          this.opts.url,
          this.opts.agentId,
          this.opts.agentName,
          this.publicKey!,
          this.signingKey!,
          this.opts.subscriptions,
        );
        this.sessionId = await connect(
          this.opts.url,
          this.opts.agentId,
          this.signingKey!,
          this.opts.ccSessionId,
        );
        this.opts.onConnect?.(this.sessionId!);
      },
      {
        shouldStop: () => this.stopped,
        onError: (e, ms) =>
          this.opts.onError?.(
            new Error(`Wire startup failed: ${e}; retrying in ${ms}ms`),
          ),
      },
    );

    if (this.stopped) return;

    this.heartbeatLoop(this.opts.heartbeatInterval ?? 10_000);
    this.streamLoop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abortController?.abort();
    if (this.sessionId && this.signingKey) {
      await disconnect(
        this.opts.url,
        this.opts.agentId,
        this.sessionId,
        this.signingKey,
      );
      this.sessionId = null;
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

  // --- Heartbeat ---

  private async heartbeatLoop(intervalMs: number): Promise<void> {
    this.log.debug({ event: "heartbeat_loop_start", intervalMs }, "heartbeat loop started");
    while (!this.stopped) {
      await new Promise((r) => setTimeout(r, intervalMs));
      if (this.stopped) return;
      if (this.sessionId && this.signingKey) {
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

  // --- SSE ---

  // Track last event ID for reconnect (SSE spec Last-Event-ID)
  private lastEventId: string | null = null;

  private async streamOnce(): Promise<void> {
    this.log.debug({ event: "sse_connect", session: this.sessionId }, "SSE_CONNECT");
    const streamUrl = `${this.opts.url}/agents/${this.opts.agentId}/stream?session_id=${this.sessionId}`;
    this.abortController = new AbortController();
    const headers: Record<string, string> = {
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    };
    // Send Last-Event-ID on reconnect so server can resume from where we left off
    if (this.lastEventId) {
      headers["Last-Event-ID"] = this.lastEventId;
    }
    const res = await fetch(streamUrl, {
      signal: this.abortController.signal,
      headers,
    });
    if (!res.ok || !res.body) {
      // Session rejected (reaped or invalid) — clear so reconnect creates a new one
      if (res.status === 403) {
        this.sessionId = null;
        this.lastEventId = null;
      }
      throw new Error(`SSE failed (${res.status})`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          this.log.warn({ event: "sse_stream_ended", session: this.sessionId }, "SSE stream reader returned done=true");
          break;
        }
        buf += decoder.decode(value, { stream: true });
        const { events, remaining } = parseSSEChunk(buf);
        buf = remaining;
        for (const sseEvent of events) {
          // Track last event ID for reconnect
          if (sseEvent.id) {
            this.lastEventId = sseEvent.id;
          }
          try {
            const event = JSON.parse(sseEvent.data) as WireEvent;
            await this.handleEvent(event);
          } catch (e) {
            this.log.error({ event: "sse_parse_error", data: sseEvent.data?.slice(0, 200), err: e }, "SSE_PARSE_ERROR");
          }
        }
      }
    } finally {
      this.abortController = null;
      reader.releaseLock();
    }
  }

  private async streamLoop(): Promise<void> {
    let backoff = 1000;
    while (!this.stopped) {
      try {
        await this.streamOnce();
        if (this.stopped) return;
        this.log.warn({ event: "sse_stream_exited" }, "streamOnce returned without error");
        backoff = 1000;
      } catch (e) {
        if (this.stopped) return;
        this.log.error({ event: "sse_error", err: e, backoff }, "SSE error, reconnecting");
        this.opts.onError?.(
          new Error(`Wire SSE error: ${e}; retrying in ${backoff}ms`),
        );
      }

      this.opts.onDisconnect?.();
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30000);
      if (this.stopped) return;

      // Reconnect: keep existing sessionId — the server marks the session
      // stale on SSE abort but doesn't destroy it. When we re-open the SSE
      // stream with the same session_id, the server resurrects it and replays
      // from our cursor. Only create a new session if the stream fails (403).
      await retryWithBackoff(
        async () => {
          if (this.signingKey) {
            const pubB64 = await derivePublicKeyB64(this.signingKey);
            await register(
              this.opts.url,
              this.opts.agentId,
              this.opts.agentName,
              pubB64,
              this.signingKey,
              this.opts.subscriptions,
            ).catch((e) => {
              this.log.error({ event: "register_retry_failed", err: e }, "REGISTER_RETRY_FAILED");
            });
          }
          // Don't create a new session — reuse the existing one.
          // streamOnce() will attempt to reconnect with the same sessionId.
          // If the server rejects it (session reaped), streamOnce throws and
          // we'll create a new session on the next retry.
          if (!this.sessionId) {
            this.sessionId = await connect(
              this.opts.url,
              this.opts.agentId,
              this.signingKey!,
              this.opts.ccSessionId,
            );
            this.opts.onConnect?.(this.sessionId!);
          }
        },
        {
          shouldStop: () => this.stopped,
          onError: (e, ms) =>
            this.opts.onError?.(
              new Error(
                `Wire reconnect failed: ${e}; retrying in ${ms}ms`,
              ),
            ),
        },
      );
      backoff = 1000;
    }
  }
}
