/**
 * Retry helper with exponential backoff.
 */
export async function retryWithBackoff(
  fn: () => Promise<void>,
  opts?: {
    maxBackoff?: number;
    initialBackoff?: number;
    shouldStop?: () => boolean;
    onError?: (error: unknown, backoffMs: number) => void;
  },
): Promise<void> {
  const maxBackoff = opts?.maxBackoff ?? 30000;
  const shouldStop = opts?.shouldStop ?? (() => false);
  let backoff = opts?.initialBackoff ?? 1000;

  while (!shouldStop()) {
    try {
      await fn();
      return;
    } catch (e) {
      if (shouldStop()) return;
      opts?.onError?.(e, backoff);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, maxBackoff);
    }
  }
}
