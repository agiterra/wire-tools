/**
 * AGI-96 (a) — tool-level proof of the init-race guard.
 *
 * These drive registerWireTools through a real in-memory MCP client, the way
 * Claude Code does, during the window where the Wire connection is not yet up.
 * The unit tests in ready-gate.test.ts cover the gate; these cover what the
 * AGENT actually receives from a tool call in that window.
 */
import { describe, expect, test } from "bun:test";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { registerWireTools } from "./mcp-server.js";
import { ReadyGate } from "./ready-gate.js";
import { generateKeyPair, type KeyPair } from "./crypto.js";

/** A wire MCP server whose connection readiness we control, as startServer's does. */
async function harness(opts: {
  gate: ReadyGate;
  keyAvailable: () => KeyPair | null;
  readyTimeoutMs?: number;
}) {
  const server = new Server(
    { name: "wire", version: "test" },
    { capabilities: { tools: {} } },
  );
  registerWireTools(server, {
    wireUrl: "http://127.0.0.1:1", // nothing listens — calls fail at transport
    agentId: "queijinho",
    getKeyPair: opts.keyAvailable,
    isPollMode: () => false,
    drain: () => [],
    waitReady: (ms) => opts.gate.wait(ms ?? opts.readyTimeoutMs ?? 1000),
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "claude-code", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}

describe("AGI-96 (a) init race — tool behaviour during the startup window", () => {
  test("set_plan called before the connection is up WAITS, then proceeds once ready", async () => {
    const gate = new ReadyGate();
    const kp = await generateKeyPair();
    let key: KeyPair | null = null; // key not installed yet, as at boot
    const client = await harness({ gate, keyAvailable: () => key, readyTimeoutMs: 3000 });

    // Connection comes up 100ms in — mirroring the 2000ms sleep + connect RTT.
    setTimeout(() => {
      key = kp;
      gate.markReady();
    }, 100);

    const res: any = await client.callTool({ name: "set_plan", arguments: { plan: "x" } });
    const text = res.content[0].text as string;

    // It got PAST the readiness guard: the failure is now a transport failure
    // against the (absent) gateway, not "not initialized".
    expect(text).not.toContain("not initialized");
    expect(text).toContain("set_plan failed");
    expect(text).toContain("WIRE_TRANSPORT");
  });

  test("when the connection never comes up, the error names the state and says retry", async () => {
    const gate = new ReadyGate();
    const client = await harness({ gate, keyAvailable: () => null, readyTimeoutMs: 120 });
    const res: any = await client.callTool({ name: "set_plan", arguments: { plan: "x" } });
    const text = res.content[0].text as string;

    expect(text).not.toContain("not initialized");
    expect(text).toContain("not up yet");
    expect(text).toContain("Retry");
    expect(res.isError).toBe(true);
  });

  test("an already-connected server is not slowed down by the gate", async () => {
    const gate = new ReadyGate();
    gate.markReady();
    const kp = await generateKeyPair();
    const client = await harness({ gate, keyAvailable: () => kp, readyTimeoutMs: 5000 });
    const t0 = Date.now();
    await client.callTool({ name: "set_plan", arguments: { plan: "x" } });
    expect(Date.now() - t0).toBeLessThan(1000); // no added latency
  });

  test("webhook_list also honours the guard (every keyed tool, not just set_plan)", async () => {
    const gate = new ReadyGate();
    const client = await harness({ gate, keyAvailable: () => null, readyTimeoutMs: 120 });
    const res: any = await client.callTool({ name: "webhook_list", arguments: {} });
    expect(res.content[0].text).not.toContain("not initialized");
    expect(res.content[0].text).toContain("not up yet");
  });

  test("a host with no waitReady (codex injector, already connected) still works", async () => {
    // waitReady omitted entirely — tools must not break for hosts that own a
    // live connection and never had this race.
    const kp = await generateKeyPair();
    const server = new Server({ name: "wire", version: "test" }, { capabilities: { tools: {} } });
    registerWireTools(server, {
      wireUrl: "http://127.0.0.1:1",
      agentId: "codex",
      getKeyPair: () => kp,
      isPollMode: () => false,
      drain: () => [],
    });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "codex", version: "0.0.0" }, { capabilities: {} });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    const res: any = await client.callTool({ name: "set_plan", arguments: { plan: "x" } });
    expect(res.content[0].text).toContain("set_plan failed");
    expect(res.content[0].text).not.toContain("not up yet");
  });
});
