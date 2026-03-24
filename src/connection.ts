/**
 * ExchangeConnection — stateful connection to an Exchange server.
 *
 * Composes the stateless tools (crypto, http, sse, reconnect) into the
 * standard Exchange protocol lifecycle, plus an inbound message pipeline:
 *
 *   SSE event → channel handler → enrichment pipeline → deliver
 *
 * Adapter authors use this as their main interface. Channel plugins
 * (IPC, Slack, etc.) register handlers. Enrichment stages are configured
 * by the agent.
 */

import { loadOrCreateKey, derivePublicKeyB64 } from "./crypto.js";
import {
  register,
  connect,
  disconnect,
  ack as ackHttp,
  heartbeat as heartbeatHttp,
  type ExchangeEvent,
} from "./http.js";
import { parseSSEChunk } from "./sse.js";
import { retryWithBackoff } from "./reconnect.js";

export type { ExchangeEvent };

// --- Channel handler types ---

export type ChannelResult = {
  text: string;
  metadata: Record<string, unknown>;
};

export type ChannelHandler = {
  /** Process a raw Exchange event into a ChannelResult. */
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
  raw: ExchangeEvent;
  prior: EnrichmentResult[];
};

export type Enricher = (ctx: EnrichmentContext) => Promise<EnrichmentResult[]>;

// --- Delivery types ---

export type DeliveryPayload = {
  raw: ExchangeEvent;
  channel: ChannelResult;
  enrichment: EnrichmentResult[];
};

export type DeliverFn = (payload: DeliveryPayload) => void | Promise<void>;

// --- Connection options ---

export type ConnectionOptions = {
  url: string;
  agentId: string;
  agentName: string;
  subscriptions?: string[];
  heartbeatInterval?: number; // ms, default 120000
  deliver: DeliverFn;
  onError?: (error: unknown) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
};

export class ExchangeConnection {
  private opts: ConnectionOptions;
  private signingKey: CryptoKey | null = null;
  private publicKey: string | null = null;
  private sessionId: string | null = null;
  private abortController: AbortController | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  // Channel handler registry: topic pattern → handler
  private channelHandlers = new Map<string, ChannelHandler>();

  // Enrichment pipelines: channel name (topic pattern) → ordered enrichers
  private enrichmentPipelines = new Map<string, Enricher[]>();

  constructor(opts: ConnectionOptions) {
    this.opts = opts;
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
   * The handler processes raw Exchange events into ChannelResult.
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
          this.opts.subscriptions,
        );
        this.sessionId = await connect(this.opts.url, this.opts.agentId);
        this.opts.onConnect?.();
      },
      {
        shouldStop: () => this.stopped,
        onError: (e, ms) =>
          this.opts.onError?.(
            new Error(`Exchange startup failed: ${e}; retrying in ${ms}ms`),
          ),
      },
    );

    if (this.stopped) return;

    const interval = this.opts.heartbeatInterval ?? 120_000;
    this.heartbeatTimer = setInterval(() => {
      if (this.sessionId)
        heartbeatHttp(this.opts.url, this.opts.agentId, this.sessionId);
    }, interval);

    this.streamLoop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.abortController?.abort();
    if (this.sessionId) {
      await disconnect(this.opts.url, this.sessionId);
      this.sessionId = null;
    }
  }

  // --- Ack ---

  async ack(seq: number): Promise<void> {
    if (!this.sessionId) return;
    try {
      await ackHttp(this.opts.url, this.sessionId, seq);
    } catch (e) {
      this.opts.onError?.(e);
    }
  }

  // --- Inbound pipeline ---

  private async handleEvent(event: ExchangeEvent): Promise<void> {
    // Skip own messages
    if (event.source === this.opts.agentId) {
      this.ack(event.seq);
      return;
    }

    // 1. Find channel handler for this topic
    const handler = this.findChannelHandler(event.topic);
    const validatorResult = this.extractValidatorResult(event);

    let channelResult: ChannelResult;
    if (handler) {
      const result = handler.process(event.payload, validatorResult);
      if (!result) {
        // Handler rejected the event (returned null)
        this.ack(event.seq);
        return;
      }
      channelResult = result;
    } else {
      // No handler — pass through raw payload as text
      channelResult = {
        text:
          typeof event.payload === "string"
            ? event.payload
            : JSON.stringify(event.payload),
        metadata: { source: event.source, topic: event.topic },
      };
    }

    // 2. Run enrichment pipeline
    const enrichers = this.findEnrichmentPipeline(event.topic);
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
        this.opts.onError?.(e);
      }
    }

    // 3. Deliver to adapter
    try {
      await this.opts.deliver({ raw: event, channel: channelResult, enrichment });
      this.ack(event.seq);
    } catch (e) {
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

  private extractValidatorResult(event: ExchangeEvent): unknown {
    if (
      typeof event.payload === "object" &&
      event.payload !== null &&
      "validator_result" in (event.payload as Record<string, unknown>)
    ) {
      return (event.payload as Record<string, unknown>).validator_result;
    }
    return undefined;
  }

  // --- SSE ---

  private async streamOnce(): Promise<void> {
    const streamUrl = `${this.opts.url}/agents/${this.opts.agentId}/stream?session_id=${this.sessionId}`;
    this.abortController = new AbortController();
    const res = await fetch(streamUrl, {
      signal: this.abortController.signal,
      headers: {
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
    if (!res.ok || !res.body)
      throw new Error(`SSE failed (${res.status})`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const { events, remaining } = parseSSEChunk(buf);
        buf = remaining;
        for (const raw of events) {
          try {
            const event = JSON.parse(raw) as ExchangeEvent;
            await this.handleEvent(event);
          } catch {}
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
        backoff = 1000;
      } catch (e) {
        if (this.stopped) return;
        this.opts.onError?.(
          new Error(`Exchange SSE error: ${e}; retrying in ${backoff}ms`),
        );
      }

      this.opts.onDisconnect?.();
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30000);
      if (this.stopped) return;

      await retryWithBackoff(
        async () => {
          if (this.signingKey) {
            const pubB64 = await derivePublicKeyB64(this.signingKey);
            await register(
              this.opts.url,
              this.opts.agentId,
              this.opts.agentName,
              pubB64,
              this.opts.subscriptions,
            ).catch(() => {});
          }
          this.sessionId = await connect(this.opts.url, this.opts.agentId);
          this.opts.onConnect?.();
        },
        {
          shouldStop: () => this.stopped,
          onError: (e, ms) =>
            this.opts.onError?.(
              new Error(
                `Exchange reconnect failed: ${e}; retrying in ${ms}ms`,
              ),
            ),
        },
      );
      backoff = 1000;
    }
  }
}
