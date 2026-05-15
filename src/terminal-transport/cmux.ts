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
        const child = spawn("cmux", ["send", "--surface", surface, prompt], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        child.on("error", () => resolve(false));
        child.on("exit", (code) => resolve(code === 0));
      });
    },
  };
}
