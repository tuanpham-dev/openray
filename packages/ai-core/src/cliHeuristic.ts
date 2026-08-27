/**
 * Best-effort text extraction from one NDJSON event line emitted by a
 * local agent CLI (Claude Code, Codex, Antigravity/`agy`), tolerant of
 * each CLI's own `stream-json`/`--json` event shape. Port of
 * `src-tauri/src/application/ai/providers/cli.rs`'s `extract_text_heuristic`
 * — see that file's doc comment for the full rationale (verified live
 * against each CLI) behind every branch and the `alreadyStreamed` gate.
 */
export function extractTextHeuristic(line: string, alreadyStreamed: boolean): string | null {
  const trimmed = line.trim()
  if (!trimmed) return null

  let event: unknown
  try {
    event = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (typeof event !== 'object' || event === null) return null
  const root = event as Record<string, unknown>

  if (typeof root.text === 'string') return root.text

  const delta = root.delta
  if (isRecord(delta) && typeof delta.text === 'string') return delta.text

  const message = root.message
  if (isRecord(message) && Array.isArray(message.content)) {
    const joined = message.content
      .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === 'text')
      .map((block) => (typeof block.text === 'string' ? block.text : ''))
      .join('')
    if (joined) return joined
  }

  const item = root.item
  if (isRecord(item) && item.type === 'agent_message' && typeof item.text === 'string') {
    return item.text
  }

  const stepUpdate = root.step_update
  if (isRecord(stepUpdate) && stepUpdate.step_type === 'agent_response' && typeof stepUpdate.text_delta === 'string') {
    return stepUpdate.text_delta
  }

  if (!alreadyStreamed) {
    if (typeof root.result === 'string') return root.result
    const result = root.result
    if (isRecord(result) && typeof result.response === 'string') return result.response
  }

  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
