/**
 * SSE chunk parser. Extracts `data:` lines from a Server-Sent Events stream.
 */
export function parseSSEChunk(
  chunk: string,
): { events: string[]; remaining: string } {
  const events: string[] = [];
  const parts = chunk.split("\n\n");
  const remaining = parts.pop() ?? "";
  for (const part of parts) {
    for (const line of part.split("\n")) {
      if (line.startsWith("data: ")) {
        events.push(line.slice(6));
      }
    }
  }
  return { events, remaining };
}
