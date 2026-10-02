/**
 * mcp-server: the exit paths must work BEFORE the first Wire connect succeeds.
 *
 * Regression (2026-10-02, Baguette 651292): startServer() registered its stdin-end / SIGTERM / orphan
 * handlers only after `await conn.start()`, which resolves on the first successful connect. Against an
 * unreachable broker that await never resolves, so a server whose Claude Code exited stayed alive forever,
 * reparented to pid 1 (8 such orphans found on _ephemeral). In production that is a lane that exits during
 * a broker outage: its server outlives it, then connects under the lane's identity when the broker returns.
 *
 * Each test spawns the real startServer() pointed at a refused port and triggers one exit path while the
 * connect is still pending (after the 2 s pre-connect delay).
 */

import { test, expect } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { generateKeyPair, exportPrivateKey } from "../src/crypto.js";

const SERVER = resolve(import.meta.dir, "../src/mcp-server.ts");
const DEAD_URL = "http://127.0.0.1:9"; // discard port: connection refused, the client retries forever
const BOOT_PENDING_MS = 3500; // past the 2 s pre-connect delay, so conn.start() is in flight

async function env(extra: Record<string, string> = {}): Promise<Record<string, string>> {
  const kp = await generateKeyPair();
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) e[k] = v;
  delete e.WIRE_MCP_INBOUND;
  return {
    ...e,
    AGENT_PRIVATE_KEY: await exportPrivateKey(kp.privateKey),
    AGENT_ID: "exit-before-connect-test",
    WIRE_URL: DEAD_URL,
    HOME: mkdtempSync(join(tmpdir(), "wire-exit-test-")),
    ...extra,
  };
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitGone(pid: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    await Bun.sleep(100);
  }
  return !alive(pid);
}

function spawnServer(e: Record<string, string>) {
  return Bun.spawn(["bun", "-e", `import { startServer } from ${JSON.stringify(SERVER)}; await startServer();`], {
    env: e, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
}

test("stdin close while the first connect is pending → exits, logging stdin_end/close", async () => {
  const p = spawnServer(await env());
  await Bun.sleep(BOOT_PENDING_MS);
  expect(alive(p.pid)).toBe(true); // control: it is up and still trying to connect
  p.stdin.end();
  const gone = await waitGone(p.pid, 8000);
  if (!gone) p.kill("SIGKILL");
  const err = await new Response(p.stderr).text();
  expect(gone).toBe(true);
  expect(err).toMatch(/"reason":"stdin_(end|close)"/);
}, 20000);

test("SIGTERM while the first connect is pending → exits, logging SIGTERM", async () => {
  const p = spawnServer(await env());
  await Bun.sleep(BOOT_PENDING_MS);
  expect(alive(p.pid)).toBe(true);
  p.kill("SIGTERM");
  const gone = await waitGone(p.pid, 8000);
  if (!gone) p.kill("SIGKILL");
  const err = await new Response(p.stderr).text();
  expect(gone).toBe(true);
  expect(err).toMatch(/"reason":"SIGTERM"/);
}, 20000);

test("parent dies (stdin still open) while the first connect is pending → orphan watchdog exits", async () => {
  // sh starts the server in the background with OUR stdin pipe (so stdin never closes), prints its pid,
  // then waits. Killing sh reparents the server; only the orphan watchdog can end it.
  const e = await env();
  const cmd = `bun -e 'import { startServer } from ${JSON.stringify(SERVER)}; await startServer();' <&0 2>/dev/null & echo $!; wait`;
  const sh = Bun.spawn(["sh", "-c", cmd], { env: e, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  const reader = sh.stdout.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  const pid = parseInt(first.trim(), 10);
  expect(pid).toBeGreaterThan(1);
  await Bun.sleep(BOOT_PENDING_MS);
  expect(alive(pid)).toBe(true);
  sh.kill("SIGKILL");
  const gone = await waitGone(pid, 12000); // watchdog polls every 5 s
  if (!gone) process.kill(pid, "SIGKILL");
  sh.stdin.end();
  expect(gone).toBe(true);
}, 25000);

test("inbound=none (control tools only): stdin close → exits", async () => {
  const p = spawnServer(await env({ WIRE_MCP_INBOUND: "none" }));
  await Bun.sleep(1500);
  expect(alive(p.pid)).toBe(true);
  p.stdin.end();
  const gone = await waitGone(p.pid, 8000);
  if (!gone) p.kill("SIGKILL");
  const err = await new Response(p.stderr).text();
  expect(gone).toBe(true);
  expect(err).toMatch(/"reason":"stdin_(end|close)"/);
}, 20000);
