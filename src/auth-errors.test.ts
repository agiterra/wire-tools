import { describe, test, expect } from "bun:test";
import {
  classifyWireError,
  classifyThrownWireError,
  formatWireError,
} from "./auth-errors";

describe("AGI-96 (b) auth degradation — classification", () => {
  // These two bodies are the REAL strings observed in
  // ~/.wire/mcp-stderr/wire.log on patisserie (2026-07-10 .. 2026-07-30).
  test("403 + invalid JWT signature ⇒ bad_signature, needs re-register", () => {
    const info = classifyWireError(
      403,
      '{"error":"JWT verification failed: invalid JWT signature"}',
    );
    expect(info.class).toBe("bad_signature");
    expect(info.code).toBe("WIRE_AUTH_BAD_SIGNATURE");
    expect(info.needsReregister).toBe(true);
    expect(info.retryable).toBe(false);
  });

  test("403 + session does not belong to agent ⇒ session_foreign, reset not re-register", () => {
    const info = classifyWireError(
      403,
      '{"error":"session does not belong to agent"}',
    );
    expect(info.class).toBe("session_foreign");
    expect(info.needsSessionReset).toBe(true);
    expect(info.needsReregister).toBe(false);
  });

  test("the two 403s are NOT the same error — the whole point", () => {
    const sig = classifyWireError(403, '{"error":"JWT verification failed"}');
    const sess = classifyWireError(403, '{"error":"session does not belong to agent"}');
    expect(sig.code).not.toBe(sess.code);
    expect(sig.needsReregister).not.toBe(sess.needsReregister);
  });

  test("404 ⇒ unknown_agent, retryable — this is the init race seen from the gateway", () => {
    const info = classifyWireError(404, "");
    expect(info.class).toBe("unknown_agent");
    expect(info.retryable).toBe(true);
    expect(info.remedy).toContain("init race");
  });

  test("401 ⇒ unauthenticated, not retryable, points at AGENT_PRIVATE_KEY", () => {
    const info = classifyWireError(401, "");
    expect(info.code).toBe("WIRE_AUTH_UNAUTHENTICATED");
    expect(info.retryable).toBe(false);
    expect(info.remedy).toContain("AGENT_PRIVATE_KEY");
  });

  test("429 ⇒ rate_limited, and explicitly says do NOT re-register", () => {
    const info = classifyWireError(429, "");
    expect(info.class).toBe("rate_limited");
    expect(info.needsReregister).toBe(false);
    expect(info.remedy).toContain("Do NOT");
  });

  test("409 ⇒ conflict", () => {
    expect(classifyWireError(409, "").code).toBe("WIRE_CONFLICT");
  });

  test("5xx ⇒ server_error, retryable", () => {
    const info = classifyWireError(503, "");
    expect(info.class).toBe("server_error");
    expect(info.retryable).toBe(true);
  });

  test("no HTTP status ⇒ transport class (socket closed unexpectedly)", () => {
    const info = classifyWireError(null, "The socket connection was closed unexpectedly");
    expect(info.class).toBe("transport");
    expect(info.retryable).toBe(true);
  });

  test("every class carries a distinct machine code", () => {
    const codes = [401, 403, 404, 409, 429, 503].map((s) => classifyWireError(s, "").code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  test("parses the real thrown-error shape http.ts produces today", () => {
    // http.ts:261 — `Wire ack failed (403): {"error":"..."}`
    const info = classifyThrownWireError(
      new Error('Wire ack failed (403): {"error":"session does not belong to agent"}'),
    );
    expect(info.class).toBe("session_foreign");
    expect(info.status).toBe(403);
  });

  test("formatted string names the class, the status and the remedy", () => {
    const body = '{"error":"JWT verification failed: invalid JWT signature"}';
    const s = formatWireError("set_plan", classifyWireError(403, body), body);
    expect(s).toContain("set_plan failed");
    expect(s).toContain("WIRE_AUTH_BAD_SIGNATURE");
    expect(s).toContain("HTTP 403");
    expect(s).toContain("Re-register");
  });
});
