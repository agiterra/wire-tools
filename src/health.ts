/**
 * HealthTracker — the periodic "I am still here and this is what I last saw"
 * line for the wire MCP server.
 *
 * AGI-96 (c) "inbound idle". Today a wire MCP server logs `connected` +
 * `conn_state_initial` at boot and then, if nothing is ever delivered to it,
 * logs NOTHING for the rest of its life. Measured on patisserie for
 * 2026-09-10: of 37 wire MCP processes in ~/.wire/mcp-stderr/wire.log, 18
 * emitted exactly two lines — connect and initial-state — and never spoke
 * again.
 *
 * That means a healthy-but-quiet lane and a lane whose SSE stream died
 * silently produce BYTE-IDENTICAL logs. "Inbound idle" is therefore not
 * currently measurable from outside the process, which is why AGI-96 asks
 * for it: the fix is not more error handling, it is a heartbeat in the log.
 *
 * This emits one structured line every `intervalMs` carrying the three facts
 * an outside watcher needs to tell "quiet" from "dark":
 *
 *   - connected_since / connected_for_ms  — is the stream actually up?
 *   - last_delivery_seq / _at / since_ms  — has anything EVER arrived, and
 *                                            how stale is it?
 *   - last_error / last_error_at          — did we fail quietly in between?
 *
 * A watcher can then alarm on "connected, but since_last_delivery_ms keeps
 * growing while the gateway's outbound queue for this agent is non-empty" —
 * which is exactly the inbound-idle condition, and is undetectable today.
 */

export type WireHealthState = "unknown" | "connected" | "disconnected";

export type HealthSnapshot = {
  event: "wire_health";
  state: WireHealthState;
  session_id: string | null;
  connected_since: string | null;
  connected_for_ms: number | null;
  /** Total connect transitions this process has seen (flap counter). */
  connects: number;
  disconnects: number;
  deliveries: number;
  last_delivery_seq: number | null;
  last_delivery_at: string | null;
  last_delivery_source: string | null;
  since_last_delivery_ms: number | null;
  last_error: string | null;
  last_error_at: string | null;
};

export type HealthEmit = (snapshot: HealthSnapshot) => void;

/** Default cadence. Long enough to be quiet in the log, short enough that a
 *  dark stream is visible well inside a lane's lifetime. */
export const DEFAULT_HEALTH_INTERVAL_MS = 300_000; // 5 minutes

function iso(t: number | null): string | null {
  return t === null ? null : new Date(t).toISOString();
}

export class HealthTracker {
  private state: WireHealthState = "unknown";
  private sessionId: string | null = null;
  private connectedAt: number | null = null;
  private connects = 0;
  private disconnects = 0;
  private deliveries = 0;
  private lastDeliverySeq: number | null = null;
  private lastDeliveryAt: number | null = null;
  private lastDeliverySource: string | null = null;
  private lastError: string | null = null;
  private lastErrorAt: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  onConnect(sessionId: string, now = Date.now()): void {
    this.state = "connected";
    this.sessionId = sessionId;
    this.connectedAt = now;
    this.connects += 1;
  }

  onDisconnect(now = Date.now()): void {
    // Only count a real transition — repeated stream_dead while already down
    // is not another outage.
    if (this.state === "disconnected") return;
    this.state = "disconnected";
    this.disconnects += 1;
    this.connectedAt = null;
    void now;
  }

  onDelivery(seq: number, source?: string, now = Date.now()): void {
    this.deliveries += 1;
    this.lastDeliverySeq = seq;
    this.lastDeliveryAt = now;
    this.lastDeliverySource = source ?? null;
  }

  onError(err: unknown, now = Date.now()): void {
    this.lastError = err instanceof Error ? err.message : String(err);
    this.lastErrorAt = now;
  }

  snapshot(now = Date.now()): HealthSnapshot {
    return {
      event: "wire_health",
      state: this.state,
      session_id: this.sessionId,
      connected_since: iso(this.connectedAt),
      connected_for_ms: this.connectedAt === null ? null : now - this.connectedAt,
      connects: this.connects,
      disconnects: this.disconnects,
      deliveries: this.deliveries,
      last_delivery_seq: this.lastDeliverySeq,
      last_delivery_at: iso(this.lastDeliveryAt),
      last_delivery_source: this.lastDeliverySource,
      since_last_delivery_ms:
        this.lastDeliveryAt === null ? null : now - this.lastDeliveryAt,
      last_error: this.lastError,
      last_error_at: iso(this.lastErrorAt),
    };
  }

  /**
   * Begin emitting. Emits once immediately so a short-lived lane still leaves
   * one health line behind (many toolsmith lanes live <5 minutes — without
   * the immediate emit they would contribute nothing, which is the very gap
   * this closes).
   */
  start(emit: HealthEmit, intervalMs = DEFAULT_HEALTH_INTERVAL_MS): void {
    this.stop();
    emit(this.snapshot());
    this.timer = setInterval(() => emit(this.snapshot()), intervalMs);
    // Never keep the process alive just to log about itself.
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
