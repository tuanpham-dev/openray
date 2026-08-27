/**
 * Minimal Server-Sent-Events line reader shared by the streaming
 * adapters — port of
 * `src-tauri/src/application/ai/providers/sse.rs`. Only `data:` lines
 * matter to any of these APIs — the payload always carries its own
 * `type`/`event` discriminant field, so the SSE `event:` line is never
 * needed. Reads a Node `fetch` `Response.body` (a web `ReadableStream`).
 */
export async function readSseLines(body: ReadableStream<Uint8Array>, onData: (data: string) => void): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newlineIndex: number
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, '')
        buffer = buffer.slice(newlineIndex + 1)
        if (line.startsWith('data: ')) {
          onData(line.slice('data: '.length))
        } else if (line.startsWith('data:')) {
          onData(line.slice('data:'.length).trimStart())
        }
      }
    }
    if (buffer.startsWith('data: ')) onData(buffer.slice('data: '.length))
    else if (buffer.startsWith('data:')) onData(buffer.slice('data:'.length).trimStart())
  } finally {
    reader.releaseLock()
  }
}
