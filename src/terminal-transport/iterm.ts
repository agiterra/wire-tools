import { spawn } from "child_process";
import type { TerminalTransport } from "./types.js";

/**
 * iTerm2 transport via AppleScript. Last-resort because AppleScript is
 * slow (~50-200ms per send) and depends on the GUI app being responsive.
 *
 * Active when $TERM_PROGRAM=iTerm.app AND $ITERM_SESSION_ID is set.
 *
 * iTerm2's $ITERM_SESSION_ID is formatted "w0t0p1:<uuid>". The AppleScript
 * dictionary accepts the full string in newer iTerm builds, so we pass
 * it verbatim.
 *
 *   osascript -e 'tell application "iTerm"' \
 *             -e 'tell session id "<ITERM_SESSION_ID>"' \
 *             -e 'write text "<prompt>"' \
 *             -e 'end tell' \
 *             -e 'end tell'
 *
 * AppleScript string escaping: backslash and double-quote need escaping
 * in the embedded prompt. Newlines must be literal `\n` (AppleScript will
 * interpret them as line breaks when written).
 */
export function detectIterm(): TerminalTransport | null {
  if (process.env.TERM_PROGRAM !== "iTerm.app") return null;
  const sessionId = process.env.ITERM_SESSION_ID;
  if (!sessionId) return null;

  return {
    name: "iterm",
    async send(prompt: string): Promise<boolean> {
      const escaped = prompt.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const lines = [
        'tell application "iTerm"',
        `tell session id "${sessionId}"`,
        `write text "${escaped}"`,
        "end tell",
        "end tell",
      ];
      return new Promise((resolve) => {
        const args = lines.flatMap((l) => ["-e", l]);
        const child = spawn("osascript", args, { stdio: ["ignore", "pipe", "pipe"] });
        child.on("error", () => resolve(false));
        child.on("exit", (code) => resolve(code === 0));
      });
    },
  };
}
