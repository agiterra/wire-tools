import { describe, expect, test } from "bun:test";
import { resolveInboundMode } from "./inbound-mode.ts";

describe("resolveInboundMode (2.22.0, j:1512)", () => {
  test("historical heuristic: claude → push, anything else → poll", () => {
    expect(resolveInboundMode({}, "claude-code").mode).toBe("push");
    expect(resolveInboundMode({}, "Claude Code").mode).toBe("push");
    expect(resolveInboundMode({}, "grok").mode).toBe("poll");
    expect(resolveInboundMode({}, undefined).mode).toBe("poll");
  });
  test("GROK_WIRE_BRIDGE=1 → none regardless of client name (the sidecar owns the stream)", () => {
    expect(resolveInboundMode({ GROK_WIRE_BRIDGE: "1" }, "grok").mode).toBe("none");
    expect(resolveInboundMode({ GROK_WIRE_BRIDGE: "1" }, "claude-code").mode).toBe("none");
    expect(resolveInboundMode({ GROK_WIRE_BRIDGE: "0" }, "grok").mode).toBe("poll");
  });
  test("WIRE_MCP_INBOUND wins over the flag and the heuristic", () => {
    expect(resolveInboundMode({ WIRE_MCP_INBOUND: "poll", GROK_WIRE_BRIDGE: "1" }, "grok").mode).toBe("poll");
    expect(resolveInboundMode({ WIRE_MCP_INBOUND: "none" }, "claude-code").mode).toBe("none");
    expect(resolveInboundMode({ WIRE_MCP_INBOUND: " PUSH " }, "grok").mode).toBe("push");
  });
  test("an invalid override is ignored, reported, and never guessed at", () => {
    const r = resolveInboundMode({ WIRE_MCP_INBOUND: "sometimes", GROK_WIRE_BRIDGE: "1" }, "grok");
    expect(r.mode).toBe("none");
    expect(r.invalidOverride).toBe("sometimes");
    expect(resolveInboundMode({ WIRE_MCP_INBOUND: "sometimes" }, "grok").mode).toBe("poll");
  });
});
