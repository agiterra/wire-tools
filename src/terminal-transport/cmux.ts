import { spawn } from "child_process";
import type { TerminalTransport } from "./types.js";

/**
 * cmux transport. Active when $CMUX_SURFACE_ID is set (cmux sets this
 * in every child process spawned in a cmux surface).
 *
 *   cmux send --surface <id> "<prompt>"
 *
 * cmux is the cross-machine pane multiplexer described at https://cmux.com
 * and used as a backend by the agiterra/crew plugin.
 */
export function detectCmux(): TerminalTransport | null {
  const surface = process.env.CMUX_SURFACE_ID;
  if (!surface) return null;
  return {
    name: "cmux",
    async send(prompt: string): Promise<boolean> {
      return new Promise((resolve) => {
        // Terminate with LF+CR (0x0A 0x0D). See screen.ts for the
        // empirical rationale — codex v0.130's TUI submits on this
        // specific sequence, not on `\r`, `\n`, or `\r\n` alone.
        const body = prompt.replace(/[\r\n]+$/, "");
        const text = body + "\n\r";
        const child = spawn("cmux", ["send", "--surface", surface, text], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        child.on("error", () => resolve(false));
        child.on("exit", (code) => resolve(code === 0));
      });
    },
  };
}
