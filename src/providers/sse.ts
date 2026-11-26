/** Minimal Server-Sent Events parser shared by streaming providers. */

export interface SSEEvent {
  event: string;
  data: string;
}

function parseChunk(chunk: string): SSEEvent | undefined {
  let event = 'message';
  const data: string[] = [];
  for (const line of chunk.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
    else if (line.startsWith('data:')) data.push(line.slice('data:'.length).trimStart().trimEnd());
  }
  return data.length ? { event, data: data.join('\n') } : undefined;
}

export async function* parseSSE(response: Response): AsyncGenerator<SSEEvent> {
  if (!response.body) throw new Error('Streaming response has no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseChunk(chunk);
        if (parsed) yield parsed;
      }
    }
    buffer += decoder.decode();
    const tail = parseChunk(buffer);
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}
