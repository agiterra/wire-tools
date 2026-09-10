/**
 * Wire auth/status error classification.
 *
 * AGI-96 (b) "auth degradation": a lane starts fine, then starts getting
 * 401/403/404/409 from the gateway. Today every caller renders these the
 * same way — `Wire ack failed (403): {"error":"..."}` (http.ts) — so the
 * agent, the operator and the fleet dashboards cannot tell apart:
 *
 *   - "my JWT signature no longer verifies"  (key rotated under us; the
 *     pubkey on file at the gateway is not the one we are signing with —
 *     needs re-register, a reconnect will NOT fix it)
 *   - "this session is not mine"             (stale/purged session row —
 *     a session reset DOES fix it, and heartbeat already knows this)
 *   - "no such agent"                        (we called before register
 *     landed — this is the (a) init race seen from the gateway side, and
 *     it fixes itself in seconds)
 *   - "rate limited"                         (back off, do not re-register)
 *
 * Each class carries a stable machine code, a human remedy, and the two
 * booleans the connection layer actually needs: whether to re-register and
 * whether to reset the session.
 */

export type WireErrorClass =
  | "unauthenticated"
  | "bad_signature"
  | "session_foreign"
  | "unknown_agent"
  | "forbidden"
  | "conflict"
  | "rate_limited"
  | "server_error"
  | "transport"
  | "unknown";

export type WireErrorInfo = {
  /** Stable machine-readable code — safe to grep, alert and dashboard on. */
  code: string;
  class: WireErrorClass;
  status: number | null;
  /** Short description of what the gateway actually rejected. */
  reason: string;
  /** What a human/agent should DO about it. */
  remedy: string;
  /** Is retrying the same call, unchanged, plausibly useful? */
  retryable: boolean;
  /** Does recovery require a fresh /agents/register (new pubkey on file)? */
  needsReregister: boolean;
  /** Does recovery require dropping the session and reconnecting? */
  needsSessionReset: boolean;
};

/** Body substrings the gateway uses today, mapped to a finer class. */
const BODY_SIGNATURES: Array<{ match: RegExp; cls: WireErrorClass }> = [
  { match: /JWT verification failed|invalid JWT signature|signature/i, cls: "bad_signature" },
  { match: /session does not belong to agent|session mismatch/i, cls: "session_foreign" },
  { match: /unknown agent|agent not found|no such agent/i, cls: "unknown_agent" },
];

const TABLE: Record<WireErrorClass, Omit<WireErrorInfo, "status" | "class">> = {
  unauthenticated: {
    code: "WIRE_AUTH_UNAUTHENTICATED",
    reason: "the gateway received no usable Authorization bearer token",
    remedy:
      "AGENT_PRIVATE_KEY is missing or unreadable in this process's env — the MCP server must be restarted with the key set (/plugin).",
    retryable: false,
    needsReregister: false,
    needsSessionReset: false,
  },
  bad_signature: {
    code: "WIRE_AUTH_BAD_SIGNATURE",
    reason:
      "the JWT signature did not verify against the public key the gateway holds for this agent",
    remedy:
      "The gateway's pubkey for this agent is not the key we are signing with (key rotated, or another process re-registered this agent id). Re-register with the current key; reconnecting alone will NOT fix this.",
    retryable: false,
    needsReregister: true,
    needsSessionReset: true,
  },
  session_foreign: {
    code: "WIRE_AUTH_SESSION_FOREIGN",
    reason: "the session id we presented does not belong to this agent",
    remedy:
      "Our session row was purged or reassigned (typical after sleep/wake or a gateway restart). Drop sessionId and reconnect to get a fresh one; the broker replays from last_ack.",
    retryable: false,
    needsReregister: false,
    needsSessionReset: true,
  },
  unknown_agent: {
    code: "WIRE_AUTH_UNKNOWN_AGENT",
    reason: "the gateway has no record of this agent id",
    remedy:
      "Register has not landed yet (outbound init race — the MCP tool surface is live ~2s before conn.start() registers) or the agent was reaped. Wait for the connection to come up and retry; this normally clears itself in seconds.",
    retryable: true,
    needsReregister: true,
    needsSessionReset: false,
  },
  forbidden: {
    code: "WIRE_AUTH_FORBIDDEN",
    reason: "authenticated, but not permitted to perform this operation",
    remedy:
      "This call needs operator privileges this agent does not hold (e.g. webhook_list against another agent). Not a connection fault — do not reconnect.",
    retryable: false,
    needsReregister: false,
    needsSessionReset: false,
  },
  conflict: {
    code: "WIRE_CONFLICT",
    reason: "the gateway reported a conflicting state for this request",
    remedy:
      "Usually a duplicate register/connect for an id that already holds a live session. Re-read current state before retrying; blind retries will keep conflicting.",
    retryable: false,
    needsReregister: false,
    needsSessionReset: true,
  },
  rate_limited: {
    code: "WIRE_RATE_LIMITED",
    reason: "the gateway is rate limiting this agent",
    remedy:
      "Back off with the existing exponential backoff. Do NOT re-register or reset the session — that adds load and resets nothing.",
    retryable: true,
    needsReregister: false,
    needsSessionReset: false,
  },
  server_error: {
    code: "WIRE_SERVER_ERROR",
    reason: "the gateway returned a 5xx",
    remedy:
      "Gateway-side fault. Retry with backoff; the client is healthy and the broker will replay unacked events on reconnect.",
    retryable: true,
    needsReregister: false,
    needsSessionReset: true,
  },
  transport: {
    code: "WIRE_TRANSPORT",
    reason: "the request never got an HTTP status (socket/DNS/TLS level failure)",
    remedy:
      "The gateway is unreachable from this host, or the connection was torn down mid-flight. Retry with backoff.",
    retryable: true,
    needsReregister: false,
    needsSessionReset: false,
  },
  unknown: {
    code: "WIRE_UNKNOWN",
    reason: "unrecognised gateway response",
    remedy: "Inspect the raw status and body; this class needs a new mapping.",
    retryable: true,
    needsReregister: false,
    needsSessionReset: false,
  },
};

function classOf(status: number | null, body: string): WireErrorClass {
  if (status === null) return "transport";
  // Body signatures win over the bare status: a 403 means three very
  // different things depending on what the gateway put in the body.
  for (const { match, cls } of BODY_SIGNATURES) {
    if (match.test(body)) return cls;
  }
  if (status === 401) return "unauthenticated";
  if (status === 403) return "forbidden";
  if (status === 404) return "unknown_agent";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  return "unknown";
}

/** Classify a gateway response. `status: null` means no HTTP status at all. */
export function classifyWireError(status: number | null, body = ""): WireErrorInfo {
  const cls = classOf(status, body);
  return { ...TABLE[cls], class: cls, status };
}

/**
 * One-line, agent-readable rendering of a failed Wire call. Replaces the
 * bare `Wire <op> failed (403): {"error":...}` string so the agent is told
 * what class of failure it is and what to do next.
 *
 *   set_plan failed [WIRE_AUTH_BAD_SIGNATURE, HTTP 403]: the JWT signature
 *   did not verify ... → The gateway's pubkey for this agent is not ...
 */
export function formatWireError(op: string, info: WireErrorInfo, body = ""): string {
  const status = info.status === null ? "no HTTP status" : `HTTP ${info.status}`;
  const detail = body.trim() ? ` | gateway said: ${body.trim().slice(0, 200)}` : "";
  return `${op} failed [${info.code}, ${status}]: ${info.reason} → ${info.remedy}${detail}`;
}

/** Parse `Wire ack failed (403): {...}` back into a classification. */
export function classifyThrownWireError(e: unknown): WireErrorInfo {
  const msg = e instanceof Error ? e.message : String(e);
  const m = /\((\d{3})\)\s*:?\s*([\s\S]*)$/.exec(msg);
  if (!m) return classifyWireError(null, msg);
  return classifyWireError(Number(m[1]), m[2] ?? "");
}
