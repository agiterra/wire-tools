import { describe, expect, test } from "bun:test";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createWireMcpServer, summarizeHeartbeats } from "./mcp-server.js";
import { generateKeyPair, type KeyPair } from "./crypto.js";

async function connectedClient(inbound: "push" | "poll" | "none") {
  const kp: KeyPair = await generateKeyPair();
  const { server } = createWireMcpServer({ agentId: "test-agent", keyPair: kp, wireUrl: "http://127.0.0.1:1", inbound });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "codex", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { client, server };
}

describe("createWireMcpServer tool surface", () => {
  test("inbound:'none' exposes control tools but NOT get_pending_messages (inbound is via turn injection)", async () => {
    const { client } = await connectedClient("none");
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["heartbeat_create", "heartbeat_delete", "heartbeat_list", "register_agent", "set_plan", "webhook_filter_get", "webhook_filter_set", "webhook_list"]);
    expect(names).not.toContain("get_pending_messages");
  });

  test("inbound:'poll' additionally exposes get_pending_messages", async () => {
    const { client } = await connectedClient("poll");
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("get_pending_messages");
    expect(names).toContain("set_plan");
  });

  test("get_pending_messages drains the deliver buffer (poll mode)", async () => {
    const kp = await generateKeyPair();
    const { server, deliver } = createWireMcpServer({ agentId: "a", keyPair: kp, inbound: "poll" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "codex", version: "0.0.0" }, { capabilities: {} });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    await deliver({
      raw: { seq: 7, source: "brioche", topic: "ipc", created_at: Date.now() },
      channel: { text: "hello", metadata: { source: "brioche" } },
    } as any);
    const res: any = await client.callTool({ name: "get_pending_messages", arguments: {} });
    const payload = JSON.parse(res.content[0].text);
    expect(payload.count).toBe(1);
    expect(payload.messages[0].content).toBe("hello");
    expect(payload.messages[0].seq).toBe(7);
  });

  test("inbound:'none' deliver() is a no-op — nothing is buffered (host handles inbound)", async () => {
    const kp = await generateKeyPair();
    const { server, deliver } = createWireMcpServer({ agentId: "a", keyPair: kp, inbound: "none" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "codex", version: "0.0.0" }, { capabilities: {} });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    await deliver({
      raw: { seq: 1, source: "x", topic: "ipc", created_at: Date.now() },
      channel: { text: "dropped", metadata: {} },
    } as any);
    // The tool isn't advertised in 'none' mode, but if force-called it must
    // drain an EMPTY buffer — proving deliver() buffered nothing.
    const res: any = await client.callTool({ name: "get_pending_messages", arguments: {} });
    expect(JSON.parse(res.content[0].text).count).toBe(0);
  });
});

describe("summarizeHeartbeats (heartbeat_list summary:true)", () => {
  const now = Date.parse("2026-09-29T14:00:00Z");
  const long = "WEEKEND CYCLE GROOMING ".repeat(400);
  const rows = summarizeHeartbeats([
    { id: "hb-1", agent_id: "brioche", cron: "0 10 * * 6", active: 1, last_fired: now - 3600_000, created_by: "brioche", created_at: 1, prompt: long },
    { id: "hb-2", agent_id: "brioche", cron: "*/5 * * * *", active: 0, last_fired: null, prompt: "short" },
  ], now) as any[];
  test("truncates the prompt to 80 chars and reports its full length", () => {
    expect(rows[0].prompt).toBe(`${long.slice(0, 80)}…`);
    expect(rows[0].prompt_chars).toBe(long.length);
    expect(rows[1].prompt).toBe("short");
  });
  test("keeps what a firing check needs: id, cron, active, last_fired as ISO + age", () => {
    expect(rows[0]).toMatchObject({ id: "hb-1", agent_id: "brioche", cron: "0 10 * * 6", active: 1, last_fired: "2026-09-29T13:00:00.000Z", last_fired_age_s: 3600 });
  });
  test("a heartbeat that never fired stays null, never 0 or epoch", () => {
    expect(rows[1].last_fired).toBeNull();
    expect(rows[1].last_fired_age_s).toBeNull();
  });
  test("drops created_by/created_at and is far smaller than the full list", () => {
    expect(rows[0]).not.toHaveProperty("created_at");
    expect(JSON.stringify(rows).length).toBeLessThan(600);
  });
  test("an unexpected (non-array) broker reply passes through untouched", () => {
    const err = { error: "nope" };
    expect(summarizeHeartbeats(err)).toBe(err);
  });
  test("summary is advertised in the heartbeat_list schema", async () => {
    const { client } = await connectedClient("none");
    const t = (await client.listTools()).tools.find((x) => x.name === "heartbeat_list")!;
    expect(Object.keys((t.inputSchema as any).properties)).toEqual(["agent_id", "summary"]);
  });
});
