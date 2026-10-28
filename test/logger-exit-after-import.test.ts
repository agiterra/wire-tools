/**
 * logger: a process that imports wire-tools and exits at once must exit 0 and keep its log lines.
 *
 * Regression (2026-10-28, ENG-5167, Baguette 796009): http.ts and connection.ts create file loggers at import
 * time. With sync:false the fd opens asynchronously, so a hook that calls process.exit() right after import
 * reached pino's exit flush before the fd existed. bun 1.3.14 printed the throw and exited 0; bun 1.4.4 turns a
 * throw in an exit listener into exit code 1 ("sonic boom is not ready yet" / "SonicBoom destroyed").
 * Every UserPromptSubmit hook that imports wire-tools (github pr-close-cleanup, operator-relay relay-hook) hit it.
 */

import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const SRC = resolve(import.meta.dir, "../src");

function run(script: string, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wire-logger-exit-"));
  const file = join(dir, "s.ts");
  writeFileSync(file, script);
  const p = Bun.spawnSync([process.execPath, "run", file], {
    env: { ...process.env, WIRE_LOG: join(dir, "wire.log"), ...env },
    stderr: "pipe",
  });
  return { dir, code: p.exitCode, stderr: p.stderr.toString() };
}

test("import then process.exit(0) exits 0 with no sonic-boom error", () => {
  const r = run(`import "${SRC}/index.ts";\nprocess.exit(0);\n`);
  expect(r.stderr).not.toMatch(/sonic ?boom/i);
  expect(r.code).toBe(0);
});

test("a file logger keeps a line written just before process.exit", () => {
  const dir = mkdtempSync(join(tmpdir(), "wire-logger-line-"));
  const log = join(dir, "l.log");
  const r = run(`import { createLogger } from "${SRC}/logger.ts";\ncreateLogger("t", ${JSON.stringify(log)}).info("kept");\nprocess.exit(0);\n`);
  expect(r.code).toBe(0);
  expect(readFileSync(log, "utf8")).toContain('"msg":"kept"');
});
