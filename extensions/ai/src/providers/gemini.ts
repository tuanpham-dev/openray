/**
 * Google Gemini streaming (`:streamGenerateContent?alt=sse`) — port of
 * `src-tauri/src/application/ai/providers/gemini.rs`. Text-only. Gemini's
 * roles are `user`/`model` rather than `user`/`assistant`, mapped at the
 * request boundary here.
 */
import { readSseLines } from './sse'
import type { ChatProvider, ChatTurn, StreamEvent } from './types'
import { splitModelId } from '@openray/ai-core'

const DEFAULT_MODEL = 'gemini-3-pro'

export const geminiProvider: ChatProvider = {
  async stream(turn: ChatTurn, onEvent: (event: StreamEvent) => void): Promise<void> {
    const apiKey = turn.apiKey
    if (!apiKey) throw new Error('auth: no Google API key configured — add one in Settings → AI')
    const [, modelPart] = splitModelId(turn.model)
    const model = modelPart || DEFAULT_MODEL
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`

    const contents = turn.messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }))
    const body: Record<string, unknown> = { contents }
    if (turn.system) body.systemInstruction = { parts: [{ text: turn.system }] }

    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (response.status === 401 || response.status === 403) throw new Error('auth: invalid Google API key')
    if (response.status === 429) throw new Error('rate_limited: Gemini is rate-limiting requests')
    if (!response.ok || !response.body) throw new Error(`network: ${response.status} ${response.statusText}`)

    let streamError: string | undefined
    await readSseLines(response.body, (data) => {
      if (streamError) return
      let event: Record<string, unknown>
      try {
        event = JSON.parse(data) as Record<string, unknown>
      } catch {
        return
      }
      const errorMessage = (event.error as Record<string, unknown> | undefined)?.message
      if (typeof errorMessage === 'string') {
        streamError = `network: ${errorMessage}`
        return
      }
      const candidate = (event.candidates as Record<string, unknown>[] | undefined)?.[0]
      const content = candidate?.content as Record<string, unknown> | undefined
      const part = (content?.parts as Record<string, unknown>[] | undefined)?.[0]
      const text = part?.text
      if (typeof text === 'string' && text) onEvent({ kind: 'delta', text })
    })

    if (streamError) throw new Error(streamError)
  },
}
