/** Port of `src-tauri/src/application/ai/providers/mod.rs`'s shared
 *  types. One `ChatProvider` per backend. */

export interface ChatMessage {
  role: string
  content: string
}

export interface ToolSpec {
  name: string
  description: string
  inputSchema: unknown
}

export type StreamEvent = { kind: 'delta'; text: string } | { kind: 'tool-use'; id: string; name: string; input: unknown }

export interface ChatTurn {
  apiKey?: string
  baseUrl?: string
  model: string
  system?: string
  messages: ChatMessage[]
  tools: ToolSpec[]
  /** Only set for `cli:custom:<name>` models — the resolved argv template
   *  (one element containing the literal `{prompt}` placeholder). */
  cliCommand?: string[]
}

export interface ChatProvider {
  stream(turn: ChatTurn, onEvent: (event: StreamEvent) => void): Promise<void>
  /** Whether this provider parses/emits tool-use events at all. */
  supportsTools?: boolean
}
