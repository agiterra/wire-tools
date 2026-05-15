import { detectScreen } from "./screen.js";
import { detectTmux } from "./tmux.js";
import { detectCmux } from "./cmux.js";
import { detectIterm } from "./iterm.js";
import type { TerminalTransport } from "./types.js";

export type { TerminalTransport };

/**
 * Probe the environment for a usable terminal-multiplexer transport.
 * Returns null if none match — caller falls back to the in-memory
 * buffer (existing behavior).
 *
 * Priority order — fastest/most-reliable first:
 *   1. screen ($STY)         — text protocol, sub-ms send
 *   2. tmux ($TMUX)          — text protocol, sub-ms send
 *   3. cmux ($CMUX_SURFACE_ID) — wraps a socket call; ~5-20ms
 *   4. iterm (AppleScript)   — ~50-200ms, GUI-dependent
 */
export function detectTerminalTransport(): TerminalTransport | null {
  return detectScreen() ?? detectTmux() ?? detectCmux() ?? detectIterm();
}
