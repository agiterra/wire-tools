import { describe, test, expect } from "bun:test";
import { WireConnection } from "./connection";

// Construct without start() — these tests drive the private watchdog directly
// (injecting a fake driver + a stubbed spawnWorker) so no real Bun Worker or
// Wire server is needed. `workerWatchdogMs` is tiny so the watchdog fires fast.
function makeConn(workerWatchdogMs = 150): Record<string, any> {
  return new WireConnection({
    url: "http://localhost:0",
    agentId: "test",
    agentName: "test",
    keyPair: { publicKey: "pk", privateKey: {} as CryptoKey },
    deliver: () => {},
    workerWatchdogMs,
  }) as unknown as Record<string, any>;
}

describe("WireConnection — frozen-worker watchdog", () => {
  test("respawns the worker after silence past the threshold", async () => {
    const conn = makeConn(120);
    let terminated = 0;
    let respawned = 0;
    conn.bootMsg = { type: "boot", url: "x", agentId: "test", agentName: "test", privateKeyB64: "x" };
    conn.driver = { postMessage() {}, terminate() { terminated++; } };
    conn.spawnWorker = () => {
      respawned++;
      conn.driver = { postMessage() {}, terminate() {} };
      conn.lastDriverMsgAt = Date.now();
    };
    conn.lastDriverMsgAt = Date.now() - 10_000; // already long-silent
    conn.startWatchdog();
    await new Promise((r) => setTimeout(r, 250));
    conn.clearWatchdog();
    expect(terminated).toBe(1);
    expect(respawned).toBe(1);
  });

  test("does NOT respawn while the worker keeps posting liveness", async () => {
    const conn = makeConn(150);
    let respawned = 0;
    conn.driver = { postMessage() {}, terminate() {} };
    conn.spawnWorker = () => { respawned++; };
    conn.startWatchdog();
    const ping = setInterval(() => conn.handleWorkerMessage({ type: "alive" }), 30);
    await new Promise((r) => setTimeout(r, 300));
    clearInterval(ping);
    conn.clearWatchdog();
    expect(respawned).toBe(0);
  });

  test("handleWorkerMessage updates the liveness clock; 'alive' is a no-op", () => {
    const conn = makeConn();
    conn.lastDriverMsgAt = 0;
    conn.handleWorkerMessage({ type: "alive" });
    expect(conn.lastDriverMsgAt).toBeGreaterThan(0);
  });

  test("a stopped connection never respawns", async () => {
    const conn = makeConn(80);
    let respawned = 0;
    conn.driver = { postMessage() {}, terminate() {} };
    conn.spawnWorker = () => { respawned++; };
    conn.lastDriverMsgAt = Date.now() - 10_000;
    conn.stopped = true;
    conn.startWatchdog();
    await new Promise((r) => setTimeout(r, 200));
    conn.clearWatchdog();
    expect(respawned).toBe(0);
  });
});
