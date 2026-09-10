/**
 * ReadyGate — bounded wait for the Wire connection to come up.
 *
 * AGI-96 (a) "outbound init race". `startServer()` connects the MCP stdio
 * transport BEFORE the Wire connection exists (mcp-server.ts: `mcp.connect`
 * then a 2000ms sleep then `conn.start()`), deliberately, so replayed SSE
 * backlog has somewhere to land. The cost is a window of >=2s + register/
 * connect RTT in which Claude Code has the full tool list and will happily
 * call an outbound tool while this agent is not yet registered with the
 * gateway. The tool then fails against the gateway (404 unknown agent /
 * 403 bad signature) or, on the codex path where the key is injected later,
 * trips the `if (!keyPair) throw new Error("not initialized")` guard.
 *
 * "not initialized" is a terrible thing to hand an agent: it is indis-
 * tinguishable from a permanent misconfiguration, so the agent gives up
 * instead of retrying 2s later when the connection is up.
 *
 * This gate makes that window WAITABLE rather than fatal. Tools call
 * `wait(ms)`; the gate resolves the moment the connection is live, and only
 * after the bounded timeout does it produce an error that says what state
 * we are actually in and how long we waited.
 */

export type ReadyState = "pending" | "ready" | "failed";

/** Default bound: comfortably longer than the 2000ms startup sleep + a
 *  register/connect round trip, short enough that a tool call never appears
 *  to hang to the agent. */
export const DEFAULT_READY_TIMEOUT_MS = 10_000;

export class WireNotReadyError extends Error {
  readonly code = "WIRE_NOT_READY";
  constructor(
    readonly state: ReadyState,
    readonly waitedMs: number,
    readonly timeoutMs: number,
    readonly cause?: Error,
  ) {
    super(
      state === "failed"
        ? `Wire connection failed to start: ${cause?.message ?? "unknown error"} ` +
          `(waited ${waitedMs}ms). This is not transient — the MCP server needs a restart (/plugin).`
        : `Wire connection not up yet after ${waitedMs}ms (limit ${timeoutMs}ms). ` +
          `The MCP server is running but its SSE/register handshake has not completed. ` +
          `Retry this tool call in a few seconds.`,
    );
    this.name = "WireNotReadyError";
  }
}

type Waiter = {
  resolve: () => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class ReadyGate {
  private state: ReadyState = "pending";
  private failure: Error | null = null;
  private waiters = new Set<Waiter>();
  private readyAt: number | null = null;

  /** Current gate state — for the health line and for tests. */
  get status(): ReadyState {
    return this.state;
  }

  get isReady(): boolean {
    return this.state === "ready";
  }

  /** Epoch ms of the first transition to ready, or null. */
  get readySince(): number | null {
    return this.readyAt;
  }

  /** Connection is live. Idempotent; releases every pending waiter. */
  markReady(now = Date.now()): void {
    if (this.state === "ready") return;
    this.state = "ready";
    this.failure = null;
    this.readyAt = now;
    for (const w of [...this.waiters]) {
      clearTimeout(w.timer);
      this.waiters.delete(w);
      w.resolve();
    }
  }

  /**
   * Startup failed unrecoverably (give_up). Releases waiters with the cause
   * rather than making them all burn their full timeout.
   */
  markFailed(err: Error): void {
    this.state = "failed";
    this.failure = err;
    for (const w of [...this.waiters]) {
      clearTimeout(w.timer);
      this.waiters.delete(w);
      w.reject(new WireNotReadyError("failed", 0, 0, err));
    }
  }

  /**
   * Drop back to pending — a reconnect is in flight. Existing waiters keep
   * waiting (they want the NEXT ready, which is what a reconnect produces).
   */
  markPending(): void {
    if (this.state === "failed") return;
    this.state = "pending";
  }

  /**
   * Wait, bounded, for the connection to be ready.
   * Resolves immediately when already ready. Throws WireNotReadyError on
   * timeout or on a failed gate — never hangs.
   */
  wait(timeoutMs = DEFAULT_READY_TIMEOUT_MS): Promise<void> {
    if (this.state === "ready") return Promise.resolve();
    if (this.state === "failed") {
      return Promise.reject(
        new WireNotReadyError("failed", 0, timeoutMs, this.failure ?? undefined),
      );
    }
    const started = Date.now();
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(
            new WireNotReadyError(this.state, Date.now() - started, timeoutMs),
          );
        }, timeoutMs),
      };
      // Don't hold the process open just to fail a tool call later.
      (waiter.timer as unknown as { unref?: () => void }).unref?.();
      this.waiters.add(waiter);
    });
  }

  /** Release timers (shutdown / tests). */
  dispose(): void {
    for (const w of [...this.waiters]) clearTimeout(w.timer);
    this.waiters.clear();
  }
}
