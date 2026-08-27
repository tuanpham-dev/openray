/**
 * Anthropic Messages API (`/v1/messages`, `stream: true`) — port of
 * `src-tauri/src/application/ai/providers/anthropic.rs`. Real incremental
 * SSE, including `tool_use` content blocks (the only provider with a tool
 * loop in this pass — see `ChatProvider.supportsTools`).
 *
 * Wire shape: `content_block_start` opens a block (text or `tool_use`),
 * `content_block_delta` carries `text_delta` chunks or `input_json_delta`
 * chunks (a tool call's input arrives as a *streamed partial JSON
 * string*, reassembled here and parsed once the block closes),
 * `content_block_stop` closes it.
 */
import { readSseLines } from './sse'
import type { ChatProvider, ChatTurn, StreamEvent } from './types'
import { splitModelId } from '@openray/ai-core'

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'
const DEFAULT_MODEL = 'claude-sonnet-5'

export const anthropicProvider: ChatProvider = {
  supportsTools: true,

  async stream(turn: ChatTurn, onEvent: (event: StreamEvent) => void): Promise<void> {
    const apiKey = turn.apiKey
    if (!apiKey) throw new Error('auth: no Anthropic API key configured — add one in Settings → AI')
    const [, modelPart] = splitModelId(turn.model)
    const model = modelPart || DEFAULT_MODEL

    const body: Record<string, unknown> = {
      model,
      max_tokens: 4096,
      stream: true,
      messages: turn.messages.map((m) => ({ role: m.role, content: m.content })),
    }
    if (turn.system) body.system = turn.system
    if (turn.tools.length > 0) {
      body.tools = turn.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }))
    }

    const response = await fetch(MESSAGES_URL, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (response.status === 401) throw new Error('auth: invalid Anthropic API key')
    if (response.status === 429) throw new Error('rate_limited: Anthropic is rate-limiting requests')
    if (!response.ok || !response.body) throw new Error(`network: ${response.status} ${response.statusText}`)

    // index -> (tool id, tool name, accumulated JSON text)
    const pendingTools = new Map<number, { id: string; name: string; json: string }>()
    let streamError: string | undefined

    await readSseLines(response.body, (data) => {
      if (streamError) return
      let event: Record<string, unknown>
      try {
        event = JSON.parse(data) as Record<string, unknown>
      } catch {
        return
      }
      const type = event.type
      if (type === 'content_block_start') {
        const index = event.index as number | undefined
        if (index === undefined) return
        const block = event.content_block as Record<string, unknown> | undefined
        if (block?.type === 'tool_use') {
          pendingTools.set(index, { id: (block.id as string) ?? '', name: (block.name as string) ?? '', json: '' })
        }
      } else if (type === 'content_block_delta') {
        const index = event.index as number | undefined
        const delta = event.delta as Record<string, unknown> | undefined
        if (index === undefined || !delta) return
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          onEvent({ kind: 'delta', text: delta.text })
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          const entry = pendingTools.get(index)
          if (entry) entry.json += delta.partial_json
        }
      } else if (type === 'content_block_stop') {
        const index = event.index as number | undefined
        if (index === undefined) return
        const entry = pendingTools.get(index)
        if (entry) {
          pendingTools.delete(index)
          let input: unknown = {}
          if (entry.json.trim()) {
            try {
              input = JSON.parse(entry.json)
            } catch {
              input = {}
            }
          }
          onEvent({ kind: 'tool-use', id: entry.id, name: entry.name, input })
        }
      } else if (type === 'error') {
        const message = (event.error as Record<string, unknown> | undefined)?.message
        streamError = `network: ${typeof message === 'string' ? message : 'unknown streaming error'}`
      }
    })

    if (streamError) throw new Error(streamError)
  },
}
