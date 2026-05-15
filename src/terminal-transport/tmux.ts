import { spawn } from "child_process";
import type { TerminalTransport } from "./types.js";

/**
 * tmux transport. Active when $TMUX is set (tmux sets this in every
 * child process). $TMUX_PANE identifies the specific pane.
 *
 *   tmux send-keys -t "$TMUX_PANE" "<prompt>" Enter
 *
 * If $TMUX_PANE is unset, tmux defaults to the active pane in the
 * current session — usually correct, but explicit is better.
 */
export function detectTmux(): TerminalTransport | null {
  if (!process.env.TMUX) return null;
  const pane = process.env.TMUX_PANE;
  return {
    name: "tmux",
    async send(prompt: string): Promise<boolean> {
      return new Promise((resolve) => {
        const args = pane
          ? ["send-keys", "-t", pane, prompt, "Enter"]
          : ["send-keys", prompt, "Enter"];
        const child = spawn("tmux", args, { stdio: ["ignore", "pipe", "pipe"] });
        child.on("error", () => resolve(false));
        child.on("exit", (code) => resolve(code === 0));
      });
    },
  };
}
