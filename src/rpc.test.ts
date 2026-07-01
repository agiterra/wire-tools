import { describe, test, expect } from "bun:test";
import type { WireEvent } from "./http.js";
import {
  RpcClient,
  RpcResponder,
  RpcTimeoutError,
  RpcRemoteError,
  RPC_REQUEST_TOPIC,
  RPC_REPLY_TOPIC,
} from "./rpc.js";

const KEY = {} as CryptoKey; // never used — send is injected everywhere

/** Wire a client and responder directly to each other, no broker. */
function pair(methods: Record<string, (params: unknown, ctx: { source: string }) => unknown>, opts?: {
  allowSource?: (source: string) => boolean;
  dropReplies?: boolean;
}) {
  let seq = 0;
  // Declared before the closures that use them.
  let client: RpcClient;
  let responder: RpcResponder;
  const clientSend = async (topic: string, payload: unknown, dest: string) => {
    const event: WireEvent = { seq: ++seq, source: "requester", topic, payload, dest, created_at: 0 };
    await responder.handleEvent(event);
    return { seq };
  };
  const responderSend = async (topic: string, payload: unknown, dest: string) => {
    if (opts?.dropReplies) return { seq: ++seq };
    const event: WireEvent = { seq: ++seq, source: "responder", topic, payload, dest, created_at: 0 };
    client.handleEvent(event);
    return { seq };
  };
  client = new RpcClient({ url: "http://x", agentId: "requester", signingKey: KEY, send: clientSend });
  responder = new RpcResponder({
    url: "http://x",
    agentId: "responder",
    signingKey: KEY,
    methods,
    allowSource: opts?.allowSource,
    send: responderSend,
    log: () => {},
  });
  return { client, responder };
}

describe("RpcClient + RpcResponder roundtrip", () => {
  test("request resolves with the handler's result", async () => {
    const { client } = pair({ add: (p) => (p as { a: number; b: number }).a + (p as { a: number; b: number }).b });
    expect(await client.request("responder", "add", { a: 2, b: 3 })).toBe(5);
    expect(client.pendingCount()).toBe(0);
  });

  test("handler context carries the broker-verified source", async () => {
    const { client } = pair({ whoami: (_p, ctx) => ctx.source });
    expect(await client.request("responder", "whoami", {})).toBe("requester");
  });

  test("unknown method rejects with RpcRemoteError", async () => {
    const { client } = pair({});
    await expect(client.request("responder", "nope", {})).rejects.toThrow(RpcRemoteError);
  });

  test("handler throw becomes a remote error, not a timeout", async () => {
    const { client } = pair({ boom: () => { throw new Error("kapow"); } });
    await expect(client.request("responder", "boom", {})).rejects.toThrow(/kapow/);
  });

  test("allowSource=false refuses with an error reply (fail closed, no timeout)", async () => {
    const { client } = pair({ secret: () => 42 }, { allowSource: () => false });
    await expect(client.request("responder", "secret", {})).rejects.toThrow(/not authorized/);
  });

  test("dropped reply times out with RpcTimeoutError and clears pending", async () => {
    const { client } = pair({ slow: () => 1 }, { dropReplies: true });
    await expect(client.request("responder", "slow", {}, 50)).rejects.toThrow(RpcTimeoutError);
    expect(client.pendingCount()).toBe(0);
  });

  test("late reply after timeout is ignored, not crashed on", async () => {
    let capturedReply: WireEvent | null = null;
    let seq = 0;
    let responder: RpcResponder;
    const client = new RpcClient({
      url: "http://x", agentId: "requester", signingKey: KEY,
      send: async (topic, payload, dest) => {
        await responder.handleEvent({ seq: ++seq, source: "requester", topic, payload, dest, created_at: 0 });
        return { seq };
      },
    });
    responder = new RpcResponder({
      url: "http://x", agentId: "responder", signingKey: KEY, log: () => {},
      methods: { m: () => "late" },
      send: async (topic, payload, dest) => {
        capturedReply = { seq: ++seq, source: "responder", topic, payload, dest, created_at: 0 };
        return { seq };
      },
    });
    await expect(client.request("responder", "m", {}, 30)).rejects.toThrow(RpcTimeoutError);
    expect(capturedReply).not.toBeNull();
    expect(client.handleEvent(capturedReply!)).toBe(false); // consumed nothing
  });
});

describe("frame pass-through (composability with normal delivery)", () => {
  test("client ignores non-reply topics and replies with unknown ids", () => {
    const client = new RpcClient({ url: "http://x", agentId: "a", signingKey: KEY, send: async () => ({ seq: 1 }) });
    expect(client.handleEvent({ seq: 1, source: "s", topic: "ipc", payload: { text: "hi" }, created_at: 0 })).toBe(false);
    expect(client.handleEvent({ seq: 2, source: "s", topic: RPC_REPLY_TOPIC, payload: { rpc: { id: "ghost" }, ok: true }, created_at: 0 })).toBe(false);
  });

  test("responder ignores non-request topics and malformed envelopes", async () => {
    const responder = new RpcResponder({ url: "http://x", agentId: "a", signingKey: KEY, methods: {}, send: async () => ({ seq: 1 }), log: () => {} });
    expect(await responder.handleEvent({ seq: 1, source: "s", topic: "ipc", payload: {}, created_at: 0 })).toBe(false);
    expect(await responder.handleEvent({ seq: 2, source: "s", topic: RPC_REQUEST_TOPIC, payload: { nope: true }, created_at: 0 })).toBe(false);
  });

  test("concurrent requests correlate independently", async () => {
    const { client } = pair({ echo: (p) => p });
    const [a, b, c] = await Promise.all([
      client.request("responder", "echo", "A"),
      client.request("responder", "echo", "B"),
      client.request("responder", "echo", "C"),
    ]);
    expect([a, b, c]).toEqual(["A", "B", "C"]);
  });
});
