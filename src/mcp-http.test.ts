import { expect, test } from "bun:test";
import { createServer } from "http";
import { randomUUID } from "crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createWireMcpServer } from "./mcp-server.js";
import { generateKeyPair } from "./crypto.js";

// Proves the single-process design: the wire MCP served over StreamableHTTP by
// the injector, reachable by a real streamable-HTTP MCP client (= how the codex
// app-server connects via config.toml [mcp_servers.wire] url=...).
test("wire MCP over StreamableHTTP: a real client can initialize + list the control tools", async () => {
  const kp = await generateKeyPair();
  const { server } = createWireMcpServer({ agentId: "codex-http", keyPair: kp, inbound: "none" });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  await server.connect(transport);

  const http = createServer((req, res) => {
    if (req.url && req.url.startsWith("/mcp")) {
      transport.handleRequest(req, res).catch(() => { if (!res.headersSent) { res.writeHead(500); res.end(); } });
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
  const port = (http.address() as { port: number }).port;

  const client = new Client({ name: "codex", version: "0.0.0" }, { capabilities: {} });
  const clientTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  try {
    await client.connect(clientTransport);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toContain("set_plan");
    expect(names).toContain("heartbeat_create");
    expect(names).toContain("register_agent");
    // inbound:'none' — inbound arrives via app-server turn injection, not the MCP
    expect(names).not.toContain("get_pending_messages");
  } finally {
    await client.close().catch(() => {});
    await new Promise<void>((r) => http.close(() => r()));
  }
});
