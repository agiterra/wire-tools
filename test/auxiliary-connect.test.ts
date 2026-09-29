/**
 * auxiliary sessions (j:1935): a helper stream must ASK the broker for auxiliary:true on
 * /agents/connect, through every layer a real caller uses (WireConnection → worker → SseRunner → connect).
 * The broker side (wire >= 1.19.0) then keeps the helper's acks off the agent's replay cursor.
 */
import { test, expect, describe } from "bun:test";
import { createServer, type Server, type ServerResponse } from "http";
import { connect } from "../src/http.js";
import { WireConnection } from "../src/connection.js";
import { generateKeyPair } from "../src/crypto.js";

type Broker = { url: string; connectBodies: any[]; close: () => Promise<void> };

async function fakeBroker(echoAuxiliary: boolean): Promise<Broker> {
  const connectBodies: any[] = [];
  const streams: ServerResponse[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0];
      if (path === "/agents/connect") {
        const body = JSON.parse(raw || "{}");
        connectBodies.push(body);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ session_id: `s-${connectBodies.length}`, last_ack_seq: 0, ...(echoAuxiliary ? { auxiliary: body.auxiliary === true } : {}) }));
      } else if (path.endsWith("/stream")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(": connected\n\n");
        streams.push(res);
      } else {
        res.statusCode = path === "/agents/register" ? 201 : 200;
        res.setHeader("content-type", "application/json");
        res.end("{}");
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  return {
    url: `http://127.0.0.1:${addr.port}`,
    connectBodies,
    close: async () => {
      for (const s of streams) s.end();
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

describe("connect() auxiliary flag", () => {
  test("auxiliary:true is sent as a strict boolean", async () => {
    const b = await fakeBroker(true);
    try {
      const kp = await generateKeyPair();
      await connect(b.url, "baguette", kp.privateKey, "bridge-rpc-baguette", { auxiliary: true });
      expect(b.connectBodies[0]).toEqual({ cc_session_id: "bridge-rpc-baguette", auxiliary: true });
    } finally { await b.close(); }
  });

  test("a normal connect does not send the field", async () => {
    const b = await fakeBroker(true);
    try {
      const kp = await generateKeyPair();
      await connect(b.url, "baguette", kp.privateKey, "7a333c61");
      expect(b.connectBodies[0]).toEqual({ cc_session_id: "7a333c61" });
    } finally { await b.close(); }
  });

  test("an older broker that ignores the field still connects (warning only)", async () => {
    const b = await fakeBroker(false);
    try {
      const kp = await generateKeyPair();
      const sid = await connect(b.url, "baguette", kp.privateKey, "crew-tools-rpc-1", { auxiliary: true });
      expect(sid).toBe("s-1");
    } finally { await b.close(); }
  });
});

describe("WireConnection auxiliary option reaches /agents/connect (the path real callers use)", () => {
  for (const auxiliary of [true, false]) {
    test(`auxiliary=${auxiliary}`, async () => {
      const b = await fakeBroker(true);
      const kp = await generateKeyPair();
      const conn = new WireConnection({
        url: b.url,
        agentId: "baguette",
        agentName: "baguette",
        ccSessionId: "crew-tools-rpc-test",
        keyPair: kp,
        ...(auxiliary ? { auxiliary: true } : {}),
        deliver: async () => {},
      });
      try {
        await conn.start();
        expect(b.connectBodies.length).toBeGreaterThanOrEqual(1);
        expect(b.connectBodies[0].auxiliary === true).toBe(auxiliary);
      } finally {
        await conn.stop();
        await b.close();
      }
    }, 15_000);
  }
});
