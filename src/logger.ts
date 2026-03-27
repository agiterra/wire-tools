/**
 * Structured logger for Wire ecosystem.
 *
 * Uses pino for JSONL output. Consumers create loggers with createLogger(),
 * optionally specifying a file or fd destination.
 */

import pino from "pino";

export type { Logger } from "pino";

/**
 * Create a pino logger.
 *
 * @param name  - Logger name (appears in every log line)
 * @param dest  - File path for JSONL output, or fd number (1=stdout, 2=stderr). Defaults to stdout.
 */
export function createLogger(
  name: string,
  dest?: string | number,
): pino.Logger {
  let target: pino.DestinationStream;
  if (typeof dest === "string") {
    target = pino.destination({ dest, append: true, mkdir: true, sync: false });
  } else {
    target = pino.destination(dest ?? 1);
  }
  return pino({ name }, target);
}
