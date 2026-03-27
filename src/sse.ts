/**
 * SSE chunk parser. Extracts `data:` and `id:` lines from a Server-Sent Events stream.
 */

export type SSEEvent = {
  data: string;
  id?: string;
};

export function parseSSEChunk(
  chunk: string,
): { events: SSEEvent[]; remaining: string } {
  const events: SSEEvent[] = [];
  const parts = chunk.split("\n\n");
  const remaining = parts.pop() ?? "";
  for (const part of parts) {
    let data: string | undefined;
    let id: string | undefined;
    for (const line of part.split("\n")) {
      if (line.startsWith("data: ")) {
        data = line.slice(6);
      } else if (line.startsWith("id: ")) {
        id = line.slice(4);
      }
      // Comments (lines starting with `:`) are silently ignored
    }
    if (data !== undefined) {
      events.push({ data, id });
    }
  }
  return { events, remaining };
}
