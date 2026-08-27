/**
 * OpenAI-compatible chat-completions streaming (`/chat/completions`,
 * `stream: true`) — port of
 * `src-tauri/src/application/ai/providers/openai.rs`. Serves both OpenAI
 * proper and Ollama (same wire format at `/v1/chat/completions`) via
 * `turn.baseUrl`. Text-only — no tool-calling adapter.
 */
import { readSseLines } from './sse'
import type { ChatProvider, ChatTurn, StreamEvent } from './types'
import { splitModelId } from '@openray/ai-core'

const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
const DEFAULT_MODEL = 'gpt-5.1'

export const openAiCompatibleProvider: ChatProvider = {
  async stream(turn: ChatTurn, onEvent: (event: StreamEvent) => void): Promise<void> {
    const [provider, modelPart] = splitModelId(turn.model)
    const model = modelPart || DEFAULT_MODEL
    const base = turn.baseUrl ?? DEFAULT_BASE_URL
    const url = `${base.replace(/\/+$/, '')}/chat/completions`

    const messages: Record<string, unknown>[] = []
    if (turn.system) messages.push({ role: 'system', content: turn.system })
    messages.push(...turn.messages.map((m) => ({ role: m.role, content: m.content })))

    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (turn.apiKey) {
      headers.authorization = `Bearer ${turn.apiKey}`
    } else if (provider === 'openai') {
      throw new Error('auth: no OpenAI API key configured — add one in Settings → AI')
    }

    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ model, stream: true, messages }) })
    if (response.status === 401) throw new Error('auth: invalid API key')
    if (response.status === 429) throw new Error('rate_limited: the server is rate-limiting requests')
    if (!response.ok || !response.body) throw new Error(`network: ${response.status} ${response.statusText}`)

    let streamError: string | undefined
    await readSseLines(response.body, (data) => {
      if (streamError || data === '[DONE]') return
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
      const choice = (event.choices as Record<string, unknown>[] | undefined)?.[0]
      const text = (choice?.delta as Record<string, unknown> | undefined)?.content
      if (typeof text === 'string' && text) onEvent({ kind: 'delta', text })
    })

    if (streamError) throw new Error(streamError)
  },
}
