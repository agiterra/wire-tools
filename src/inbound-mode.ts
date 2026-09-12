/**
 * Inbound mode for the stdio Wire MCP server (2.22.0, j:1512).
 *
 * Until 2.21.x the mode was inferred from the MCP client's name: "claude" → push, anything else → poll.
 * A Grok-bridged lane (wire-grok sidecar owns the agent's Wire stream and injects turns) also runs this
 * server for its control tools, so it inferred POLL: a SECOND consumer of the same stream, buffering every
 * packet the sidecar had already delivered and handing it to whoever calls get_pending_messages. Vacherin
 * (gate warden) polled mid-turn, acted, then received the sidecar's injection of the same packet and acted
 * again — every packet twice, ~one turn apart (Brioche 612640, 2026-09-12 03:22Z).
 *
 * Precedence — explicit over implicit (Tim 2026-09-04):
 *   1. WIRE_MCP_INBOUND=push|poll|none            — the operator/launcher said so.
 *   2. GROK_WIRE_BRIDGE=1                          — the Grok launchers export this; the sidecar owns inbound → none.
 *   3. MCP client name contains "claude" → push, otherwise poll (the historical heuristic).
 * An invalid WIRE_MCP_INBOUND value is ignored (and reported by the caller), never guessed at.
 */
export type InboundMode = "push" | "poll" | "none";

const VALID: ReadonlySet<string> = new Set(["push", "poll", "none"]);

export type InboundResolution = { mode: InboundMode; reason: string; invalidOverride?: string };

export function resolveInboundMode(
  env: Record<string, string | undefined>,
  clientName: string | undefined,
): InboundResolution {
  const override = env.WIRE_MCP_INBOUND?.trim().toLowerCase();
  if (override && VALID.has(override)) return { mode: override as InboundMode, reason: `WIRE_MCP_INBOUND=${override}` };
  const invalidOverride = override && !VALID.has(override) ? override : undefined;
  if (env.GROK_WIRE_BRIDGE === "1") return { mode: "none", reason: "GROK_WIRE_BRIDGE=1 (sidecar owns the Wire stream)", invalidOverride };
  const name = (clientName ?? "").toLowerCase();
  if (name.includes("claude")) return { mode: "push", reason: `client "${clientName}" is Claude Code`, invalidOverride };
  return { mode: "poll", reason: `client "${clientName ?? ""}" is not Claude Code (default poll)`, invalidOverride };
}
