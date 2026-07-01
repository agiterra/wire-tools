/**
 * RPC over the Wire — user-space request/response correlation on top of
 * fire-and-forget unicast (design-crew-service-federated §4).
 *
 * The broker has no reply channel: sends are one-way, receives are SSE
 * frames. This layer adds request/response semantics client-side:
 *
 *   requester                            responder
 *   ---------                            ---------
 *   RpcClient.request(dest, method) ──▶  topic "rpc.request"
 *     payload { rpc:{id,reply_to,        RpcResponder.handleEvent()
 *               reply_topic}, method,      → methods[method](params, ctx)
 *               params }                   → unicast reply to rpc.reply_to
 *   RpcClient.handleEvent()          ◀──  topic "rpc.reply"
 *     resolves pending[id]                 payload { rpc:{id}, ok,
 *                                                    result | error }
 *
 * Both sides feed their inbound SSE frames through handleEvent(); frames
 * that aren't RPC (or aren't addressed to a pending id) are left untouched
 * so the layer composes with existing delivery paths.
 *
 * Trust model: `event.source` is broker-verified for LOCAL senders (the
 * webhook ingress JWT-auths and overwrites source). Federated/forwarded
 * frames are NOT re-verified until Wire Change B lands — responders that
 * mutate state must gate with `allowSource` and refuse what they can't
 * attribute (fail closed).
 */

import type { WireEvent } from "./http.js";
import { sendSignedMessage } from "./http.js";

export const RPC_REQUEST_TOPIC = "rpc.request";
export const RPC_REPLY_TOPIC = "rpc.reply";

/**
 * The broker's webhook ingress prefixes delivered topics with "webhook."
 * (a send to /webhooks/<dest>/rpc.request arrives as topic
 * "webhook.rpc.request"). Match on the normalized form so RPC works over
 * both webhook-ingress unicast and any unprefixed delivery path.
 */
function normalizeTopic(topic: string): string {
  return topic.startsWith("webhook.") ? topic.slice("webhook.".length) : topic;
}

/**
 * Frame payloads arrive as JSON STRINGS over the broker's SSE path (the
 * router stringifies before delivery) but as objects from in-process test
 * wiring. Accept both; a non-JSON string is simply not an RPC payload.
 */
function parsePayload(payload: unknown): unknown {
  if (typeof payload !== "string") return payload;
  try {
    return JSON.parse(payload);
  } catch {
    return undefined;
  }
}

export type RpcRequestPayload = {
  rpc: { id: string; reply_to: string; reply_topic: string };
  method: string;
  params: unknown;
};

export type RpcReplyPayload = {
  rpc: { id: string };
  ok: boolean;
  result?: unknown;
  error?: string;
};

/** Sender signature shared by client and responder — injectable for tests. */
export type RpcSend = (topic: string, payload: unknown, dest: string) => Promise<unknown>;

export class RpcTimeoutError extends Error {
  constructor(public readonly method: string, public readonly dest: string, timeoutMs: number) {
    super(`RPC ${method} to ${dest} timed out after ${timeoutMs}ms`);
    this.name = "RpcTimeoutError";
  }
}

export class RpcRemoteError extends Error {
  constructor(public readonly method: string, public readonly dest: string, remoteMessage: string) {
    super(`RPC ${method} to ${dest} failed remotely: ${remoteMessage}`);
    this.name = "RpcRemoteError";
  }
}

type Pending = {
  method: string;
  dest: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type RpcClientOptions = {
  url: string;
  agentId: string;
  signingKey: CryptoKey;
  /** Topic replies arrive on (must match what this agent's inbound feed carries). */
  replyTopic?: string;
  /** Override the wire send — tests wire this straight into a responder. */
  send?: RpcSend;
  defaultTimeoutMs?: number;
};

export class RpcClient {
  private pending = new Map<string, Pending>();
  private readonly replyTopic: string;
  private readonly send: RpcSend;
  private readonly defaultTimeoutMs: number;

  constructor(private readonly opts: RpcClientOptions) {
    this.replyTopic = opts.replyTopic ?? RPC_REPLY_TOPIC;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 15_000;
    this.send =
      opts.send ??
      ((topic, payload, dest) => sendSignedMessage(opts.url, opts.agentId, opts.signingKey, topic, payload, dest));
  }

  /** Number of in-flight requests (diagnostics). */
  pendingCount(): number {
    return this.pending.size;
  }

  async request(dest: string, method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    const id = crypto.randomUUID();
    const timeout = timeoutMs ?? this.defaultTimeoutMs;
    const payload: RpcRequestPayload = {
      rpc: { id, reply_to: this.opts.agentId, reply_topic: this.replyTopic },
      method,
      params,
    };
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcTimeoutError(method, dest, timeout));
      }, timeout);
      this.pending.set(id, { method, dest, resolve, reject, timer });
    });
    try {
      await this.send(RPC_REQUEST_TOPIC, payload, dest);
    } catch (e) {
      const p = this.pending.get(id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(id);
      }
      throw e;
    }
    return result;
  }

  /**
   * Feed an inbound frame. Returns true when the frame was a reply to a
   * pending request (consumed); false to let the caller's normal delivery
   * path handle it.
   */
  handleEvent(event: WireEvent): boolean {
    if (normalizeTopic(event.topic) !== this.replyTopic) return false;
    const payload = parsePayload(event.payload) as RpcReplyPayload | undefined;
    const id = payload?.rpc?.id;
    if (!id) return false;
    const p = this.pending.get(id);
    if (!p) return false; // late/duplicate reply — already timed out or resolved
    clearTimeout(p.timer);
    this.pending.delete(id);
    if (payload.ok) p.resolve(payload.result);
    else p.reject(new RpcRemoteError(p.method, p.dest, payload.error ?? "unknown remote error"));
    return true;
  }
}

export type RpcHandlerContext = { source: string; event: WireEvent };
export type RpcHandler = (params: unknown, ctx: RpcHandlerContext) => Promise<unknown> | unknown;

export type RpcResponderOptions = {
  url: string;
  agentId: string;
  signingKey: CryptoKey;
  methods: Record<string, RpcHandler>;
  /**
   * Authorization gate — return false to refuse (the requester gets an
   * error reply, not a timeout). Defaults to allow-all; state-mutating
   * responders MUST supply one (fail closed on sources they can't verify).
   */
  allowSource?: (source: string, event: WireEvent) => boolean;
  send?: RpcSend;
  log?: (msg: string, err?: unknown) => void;
};

export class RpcResponder {
  private readonly send: RpcSend;
  private readonly log: (msg: string, err?: unknown) => void;

  constructor(private readonly opts: RpcResponderOptions) {
    this.send =
      opts.send ??
      ((topic, payload, dest) => sendSignedMessage(opts.url, opts.agentId, opts.signingKey, topic, payload, dest));
    this.log = opts.log ?? ((msg, err) => console.error(`[wire-rpc] ${msg}`, err ?? ""));
  }

  /**
   * Feed an inbound frame. Returns true when the frame was an RPC request
   * (consumed — a reply has been sent, including for errors/refusals).
   */
  async handleEvent(event: WireEvent): Promise<boolean> {
    if (normalizeTopic(event.topic) !== RPC_REQUEST_TOPIC) return false;
    const payload = parsePayload(event.payload) as RpcRequestPayload | undefined;
    const rpc = payload?.rpc;
    if (!rpc?.id || !rpc.reply_to || !payload?.method) return false;

    const reply = async (body: Omit<RpcReplyPayload, "rpc">) => {
      try {
        await this.send(rpc.reply_topic || RPC_REPLY_TOPIC, { rpc: { id: rpc.id }, ...body }, rpc.reply_to);
      } catch (e) {
        this.log(`reply send failed for ${payload.method} → ${rpc.reply_to} (id ${rpc.id})`, e);
      }
    };

    if (this.opts.allowSource && !this.opts.allowSource(event.source, event)) {
      this.log(`refused rpc ${payload.method} from unauthorized source '${event.source}'`);
      await reply({ ok: false, error: `source '${event.source}' not authorized` });
      return true;
    }

    const handler = this.opts.methods[payload.method];
    if (!handler) {
      await reply({ ok: false, error: `unknown method '${payload.method}'` });
      return true;
    }

    try {
      const result = await handler(payload.params, { source: event.source, event });
      await reply({ ok: true, result });
    } catch (e) {
      this.log(`handler '${payload.method}' threw`, e);
      await reply({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
    return true;
  }
}
