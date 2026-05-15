/**
 * Terminal-multiplexer push delivery for codex agents (and any future
 * poll-mode runtime). When a Wire message arrives, instead of buffering
 * and waiting for the agent to drain, the MCP process types the prompt
 * directly into its own stdin via the terminal multiplexer it's running
 * inside.
 *
 * Implementations key off universal env vars set by the terminal /
 * multiplexer itself ($STY, $TMUX, $CMUX_SURFACE_ID, $ITERM_SESSION_ID).
 * No dependency on crew or any other plugin — convention only.
 *
 * Per Tim 2026-05-15 + wire-tools#9.
 */

export interface TerminalTransport {
  /** Short name for logging — "screen", "tmux", "cmux", "iterm". */
  name: string;

  /** Push a formatted prompt as a new turn into the agent's stdin. */
  send(prompt: string): Promise<boolean>;
}
