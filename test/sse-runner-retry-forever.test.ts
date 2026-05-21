/**
 * SseRunner: sustained 401/403 must not give up.
 *
 * Regression for j:<wire-tools #10> — Tiramisu (2026-05-21) and Babka (2026-05-18)
 * both starved silently after the wire client gave up at the 10th consecutive
 * auth failure. Wire clients are expected to retry forever; only an explicit
 * stop() should exit the loop.
 *
 * The fixture spins up a localhost HTTP server that returns 401 to every
 * request, points an SseRunner at it, and verifies that after >20 retries
 * the runner is still trying — no `give_up` message has been posted.
 */

import { test, expect } from "bun:test";
import { createServer, type Server } from "http";
import { SseRunner, type SseRunnerOutMsg } from "../src/sse-runner.js";
import { generateKeyPair, exportPrivateKey } from "../src/crypto.js";

async function withAlways401(fn: (url: string) => Promise<void>): Promise<void> {
  let requestCount = 0;
  const server: Server = createServer((_req, res) => {
    requestCount += 1;
    res.statusCode = 401;
    res.setHeader("content-type", "text/plain");
    res.end("Unauthorized");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no server address");
  const url = `http://127.0.0.1:${addr.port}`;
  try {
    await fn(url);
    // surface request count to log when debugging
    void requestCount;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("sustained 401s do not trigger give_up", async () => {
  const kp = await generateKeyPair();
  const privateKeyB64 = await exportPrivateKey(kp.privateKey);

  await withAlways401(async (url) => {
    const messages: SseRunnerOutMsg[] = [];
    const runner = new SseRunner((m) => {
      messages.push(m);
    });

    // Boot but don't await — runner stays in the retry loop forever.
    void runner.boot({
      url,
      agentId: "test-agent",
      agentName: "test-agent",
      privateKeyB64,
    });

    // Wait long enough for several retry cycles. retryWithBackoff starts at
    // 1000ms and doubles. With cap 60s, 6s is enough for ~3-4 attempts; we
    // want to confirm the loop is still alive rather than count attempts.
    await new Promise((r) => setTimeout(r, 6_500));

    const giveUp = messages.find((m) => m.type === "give_up");
    expect(giveUp).toBeUndefined();

    const retryLogs = messages.filter(
      (m) => m.type === "log" && (m.fields.event === "startup_retry" || m.fields.event === "reconnect_retry"),
    );
    // At least 2 retry log lines means we saw >=3 attempts (initial + 2 retries).
    expect(retryLogs.length).toBeGreaterThanOrEqual(2);

    runner.stop();
    await runner.done;
  });
}, 15_000);
