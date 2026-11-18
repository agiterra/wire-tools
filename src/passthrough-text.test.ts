import { describe, test, expect } from "bun:test";
import { passthroughText } from "./connection";

// A real envelope shape, from Baguette 909311 as delivered 2026-11-18.
const ipc = {
  source: "baguette",
  topic: "webhook.ipc",
  dest: "fondant",
  plugin: "ipc",
  headers: {
    accept: "*/*",
    "accept-encoding": "gzip, deflate, br, zstd",
    connection: "keep-alive",
    "content-length": "693",
    "content-type": "application/json",
    host: "localhost:9800",
    "user-agent": "Bun/1.4.4",
  },
  payload: { type: "request", subject: "s", text: "t", evidence: "e" },
};

describe("passthroughText", () => {
  test("ipc envelope: headers dropped", () => {
    const out = JSON.parse(passthroughText(ipc));
    expect("headers" in out).toBe(false);
  });

  test("ipc envelope: source, topic, dest, plugin and the full payload stay, in order", () => {
    const out = passthroughText(ipc);
    expect(out).toBe(
      JSON.stringify({ source: "baguette", topic: "webhook.ipc", dest: "fondant", plugin: "ipc", payload: ipc.payload }),
    );
  });

  test("ipc envelope: the input object is not mutated", () => {
    passthroughText(ipc);
    expect(ipc.headers["user-agent"]).toBe("Bun/1.4.4");
  });

  test("non-ipc webhook keeps its headers (x-github-event lives there)", () => {
    const gh = { source: "github", topic: "webhook.github", plugin: "github", headers: { "x-github-event": "pull_request" }, payload: { action: "opened" } };
    expect(passthroughText(gh)).toBe(JSON.stringify(gh));
  });

  test("envelope without plugin keeps its headers", () => {
    const e = { source: "x", headers: { a: "1" }, payload: 1 };
    expect(passthroughText(e)).toBe(JSON.stringify(e));
  });

  test("string payload passes through unchanged", () => {
    expect(passthroughText("hello")).toBe("hello");
  });

  test("heartbeat payload (no headers) unchanged", () => {
    const hb = { type: "heartbeat", heartbeat_id: "hb-1", prompt: "p", created_by: "fondant" };
    expect(passthroughText(hb)).toBe(JSON.stringify(hb));
  });

  test("null, number and array payloads unchanged", () => {
    expect(passthroughText(null)).toBe("null");
    expect(passthroughText(5)).toBe("5");
    expect(passthroughText([{ plugin: "ipc", headers: {} }])).toBe(JSON.stringify([{ plugin: "ipc", headers: {} }]));
  });
});
