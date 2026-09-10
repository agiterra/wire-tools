import { describe, test, expect } from "bun:test";
import { HealthTracker, type HealthSnapshot } from "./health";

describe("AGI-96 (c) inbound idle — HealthTracker", () => {
  test("a connected-but-silent server still reports, so quiet != dark", () => {
    // The 2026-09-10 signature: connect, then nothing, ever. Today that
    // produces no further log line at all.
    const h = new HealthTracker();
    const t0 = 1_789_000_000_000;
    h.onConnect("sess-1", t0);
    const snap = h.snapshot(t0 + 600_000);
    expect(snap.state).toBe("connected");
    expect(snap.connected_for_ms).toBe(600_000);
    expect(snap.deliveries).toBe(0);
    expect(snap.last_delivery_at).toBeNull();
    // The field that makes inbound-idle measurable from outside:
    expect(snap.since_last_delivery_ms).toBeNull();
  });

  test("staleness of the last delivery is reported in ms", () => {
    const h = new HealthTracker();
    const t0 = 1_789_000_000_000;
    h.onConnect("sess-1", t0);
    h.onDelivery(608_333, "brioche", t0 + 1000);
    const snap = h.snapshot(t0 + 61_000);
    expect(snap.last_delivery_seq).toBe(608_333);
    expect(snap.last_delivery_source).toBe("brioche");
    expect(snap.since_last_delivery_ms).toBe(60_000);
    expect(snap.deliveries).toBe(1);
  });

  test("emits one line immediately — a lane that lives 4 minutes still leaves evidence", () => {
    const h = new HealthTracker();
    const seen: HealthSnapshot[] = [];
    h.onConnect("sess-1");
    h.start((s) => seen.push(s), 300_000);
    h.stop();
    expect(seen).toHaveLength(1);
    expect(seen[0].event).toBe("wire_health");
  });

  test("counts connect/disconnect flaps", () => {
    const h = new HealthTracker();
    h.onConnect("a");
    h.onDisconnect();
    h.onConnect("b");
    h.onDisconnect();
    h.onConnect("c");
    const s = h.snapshot();
    expect(s.connects).toBe(3);
    expect(s.disconnects).toBe(2);
    expect(s.session_id).toBe("c");
  });

  test("repeated stream_dead while already down is not counted twice", () => {
    const h = new HealthTracker();
    h.onConnect("a");
    h.onDisconnect();
    h.onDisconnect();
    h.onDisconnect();
    expect(h.snapshot().disconnects).toBe(1);
  });

  test("a disconnected tracker reports no connected_since", () => {
    const h = new HealthTracker();
    h.onConnect("a");
    h.onDisconnect();
    const s = h.snapshot();
    expect(s.state).toBe("disconnected");
    expect(s.connected_since).toBeNull();
    expect(s.connected_for_ms).toBeNull();
  });

  test("last error is carried on the health line", () => {
    const h = new HealthTracker();
    h.onConnect("a");
    h.onError(new Error("Wire ack failed (403)"), 1_789_000_000_000);
    const s = h.snapshot();
    expect(s.last_error).toContain("403");
    expect(s.last_error_at).toBe("2026-09-10T00:26:40.000Z");
  });

  test("snapshot is JSON-serialisable as one log line", () => {
    const h = new HealthTracker();
    h.onConnect("a");
    h.onDelivery(1, "brioche");
    expect(() => JSON.stringify(h.snapshot())).not.toThrow();
  });

  test("start() replaces a prior timer rather than stacking them", () => {
    const h = new HealthTracker();
    let n = 0;
    h.start(() => n++, 60_000);
    h.start(() => n++, 60_000);
    h.stop();
    expect(n).toBe(2); // two immediate emits, no stacked intervals
  });
});
