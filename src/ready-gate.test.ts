import { describe, test, expect } from "bun:test";
import { ReadyGate, WireNotReadyError, DEFAULT_READY_TIMEOUT_MS } from "./ready-gate";

describe("AGI-96 (a) init race — ReadyGate", () => {
  test("a tool that calls during the startup window WAITS instead of failing", async () => {
    // Reproduces mcp-server.ts startServer(): tools are live, conn.start()
    // has not run yet. Before this patch the tool path had no way to wait.
    const gate = new ReadyGate();
    expect(gate.isReady).toBe(false);
    const toolCall = gate.wait(1000);
    // Connection comes up 50ms later, as it does after the 2000ms sleep.
    setTimeout(() => gate.markReady(), 50);
    await expect(toolCall).resolves.toBeUndefined();
    expect(gate.isReady).toBe(true);
  });

  test("already-ready gate resolves without waiting", async () => {
    const gate = new ReadyGate();
    gate.markReady();
    const t0 = Date.now();
    await gate.wait(5000);
    expect(Date.now() - t0).toBeLessThan(50);
  });

  test("the wait is BOUNDED — it never hangs a tool call forever", async () => {
    const gate = new ReadyGate();
    let err: unknown;
    try {
      await gate.wait(80);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WireNotReadyError);
    expect((err as WireNotReadyError).code).toBe("WIRE_NOT_READY");
  });

  test("timeout message says what state we are in and to retry — not 'not initialized'", async () => {
    const gate = new ReadyGate();
    const err = await gate.wait(60).catch((e) => e as WireNotReadyError);
    expect(err.message).toContain("not up yet");
    expect(err.message).toContain("Retry");
    // The string the agent used to get, which reads as permanent:
    expect(err.message).not.toBe("not initialized");
  });

  test("a failed gate rejects immediately and says a restart is needed", async () => {
    const gate = new ReadyGate();
    gate.markFailed(new Error("Wire give_up: invalid private key"));
    const t0 = Date.now();
    const err = await gate.wait(5000).catch((e) => e as WireNotReadyError);
    expect(Date.now() - t0).toBeLessThan(50); // did not burn the timeout
    expect(err.message).toContain("not transient");
    expect(err.message).toContain("invalid private key");
  });

  test("markFailed releases everyone already waiting", async () => {
    const gate = new ReadyGate();
    const a = gate.wait(5000).catch((e) => (e as Error).name);
    const b = gate.wait(5000).catch((e) => (e as Error).name);
    gate.markFailed(new Error("boom"));
    expect(await a).toBe("WireNotReadyError");
    expect(await b).toBe("WireNotReadyError");
  });

  test("markReady releases every waiter at once", async () => {
    const gate = new ReadyGate();
    const waiters = [gate.wait(2000), gate.wait(2000), gate.wait(2000)];
    gate.markReady();
    await expect(Promise.all(waiters)).resolves.toHaveLength(3);
  });

  test("a reconnect drops back to pending but does not fail in-flight waiters", async () => {
    const gate = new ReadyGate();
    gate.markReady();
    gate.markPending();
    expect(gate.isReady).toBe(false);
    const w = gate.wait(1000);
    gate.markReady();
    await expect(w).resolves.toBeUndefined();
  });

  test("default bound clears the 2000ms startup sleep with margin", () => {
    expect(DEFAULT_READY_TIMEOUT_MS).toBeGreaterThan(2000);
  });

  test("dispose leaves no live timers", () => {
    const gate = new ReadyGate();
    void gate.wait(10_000).catch(() => {});
    expect(() => gate.dispose()).not.toThrow();
  });
});
