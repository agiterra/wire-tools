import { spawn } from "child_process";
import type { TerminalTransport } from "./types.js";

/**
 * GNU screen transport. Active when $STY is set (screen sets this in
 * every child process automatically).
 *
 *   screen -S "$STY" -X stuff "<prompt>\n"
 *
 * `stuff` is screen's command for injecting characters into the active
 * window's input as if they had been typed.
 */
export function detectScreen(): TerminalTransport | null {
  const sty = process.env.STY;
  if (!sty) return null;
  return {
    name: "screen",
    async send(prompt: string): Promise<boolean> {
      return new Promise((resolve) => {
        const text = prompt.endsWith("\n") ? prompt : prompt + "\n";
        const child = spawn("screen", ["-S", sty, "-X", "stuff", text], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        child.on("error", () => resolve(false));
        child.on("exit", (code) => resolve(code === 0));
      });
    },
  };
}
