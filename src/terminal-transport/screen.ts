import { spawn } from "child_process";
import type { TerminalTransport } from "./types.js";

/**
 * GNU screen transport. Active when $STY is set (screen sets this in
 * every child process automatically).
 *
 *   screen -S "$STY" -X stuff "<prompt>\r"
 *
 * `stuff` is screen's command for injecting characters into the active
 * window's input as if they had been typed. The terminating `\r`
 * (0x0D, carriage return) is what TUIs interpret as Enter — `\n`
 * (0x0A, line feed) is a soft line-break in many TUIs (verified
 * against codex's TUI: `\n` adds a visible newline in the input
 * field but does NOT submit the input).
 */
export function detectScreen(): TerminalTransport | null {
  const sty = process.env.STY;
  if (!sty) return null;
  return {
    name: "screen",
    async send(prompt: string): Promise<boolean> {
      return new Promise((resolve) => {
        // Terminate with LF+CR (0x0A 0x0D, in that order). Tested
        // empirically against codex v0.130 — `\r` alone, `\n` alone, and
        // `\r\n` all FAIL to submit (text lands in the input field but
        // codex doesn't fire a turn). `\n\r` is the working combination,
        // likely because codex appends `\n` to the buffer first, then
        // the trailing `\r` triggers submit on the (now non-empty)
        // buffer. Verified across single-line and multi-line bodies.
        const body = prompt.replace(/[\r\n]+$/, "");
        const text = body + "\n\r";
        const child = spawn("screen", ["-S", sty, "-X", "stuff", text], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        child.on("error", () => resolve(false));
        child.on("exit", (code) => resolve(code === 0));
      });
    },
  };
}
