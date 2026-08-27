import { describe, expect, it } from 'vitest'
import { extractTextHeuristic } from '../src/cliHeuristic'

// Fixtures captured from live CLI runs — mirrored verbatim from
// src-tauri/src/application/ai/providers/cli.rs's own test fixtures so
// both ports are verified against the exact same real-world event shapes.

const RATE_LIMIT_EVENT = `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"},"session_id":"s1"}`
const SYSTEM_INIT_EVENT = `{"type":"system","subtype":"init","cwd":"/tmp","session_id":"s1"}`
const ASSISTANT_EVENT = `{"type":"assistant","message":{"content":[{"type":"text","text":"hello from cli test"}]},"session_id":"s1"}`
const RESULT_EVENT = `{"is_error":false,"result":"hello from cli test","type":"result","session_id":"s1"}`

describe('Claude Code shape', () => {
  it('yields no text for non-content events', () => {
    expect(extractTextHeuristic(RATE_LIMIT_EVENT, false)).toBeNull()
    expect(extractTextHeuristic(SYSTEM_INIT_EVENT, false)).toBeNull()
  })

  it('extracts assistant message content', () => {
    expect(extractTextHeuristic(ASSISTANT_EVENT, false)).toBe('hello from cli test')
  })

  it('suppresses the result field once assistant text already streamed', () => {
    expect(extractTextHeuristic(RESULT_EVENT, true)).toBeNull()
  })

  it('uses the result field as a fallback when nothing streamed yet', () => {
    expect(extractTextHeuristic(RESULT_EVENT, false)).toBe('hello from cli test')
  })

  it('streams a full transcript exactly once', () => {
    const lines = [RATE_LIMIT_EVENT, SYSTEM_INIT_EVENT, ASSISTANT_EVENT, RESULT_EVENT]
    let streamed = ''
    let gotAny = false
    for (const line of lines) {
      const text = extractTextHeuristic(line, gotAny)
      if (text !== null) {
        gotAny = true
        streamed += text
      }
    }
    expect(streamed).toBe('hello from cli test')
  })
})

const CODEX_THREAD_STARTED = `{"type":"thread.started","thread_id":"01a01a7e-7fa2-7980-8078-6465fd0da8d4"}`
const CODEX_TURN_STARTED = `{"type":"turn.started"}`
const CODEX_AGENT_MESSAGE = `{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"codex cli test"}}`
const CODEX_COMMAND_STARTED = `{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc 'echo hello-from-tool'","aggregated_output":"","exit_code":null,"status":"in_progress"}}`
const CODEX_COMMAND_COMPLETED = `{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc 'echo hello-from-tool'","aggregated_output":"hello-from-tool\\n","exit_code":0,"status":"completed"}}`
const CODEX_SECOND_AGENT_MESSAGE = `{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"hello-from-tool"}}`
const CODEX_TURN_COMPLETED = `{"type":"turn.completed","usage":{"input_tokens":28393,"output_tokens":111}}`

describe('Codex shape', () => {
  it('yields no text for non-content events', () => {
    expect(extractTextHeuristic(CODEX_THREAD_STARTED, false)).toBeNull()
    expect(extractTextHeuristic(CODEX_TURN_STARTED, false)).toBeNull()
    expect(extractTextHeuristic(CODEX_TURN_COMPLETED, false)).toBeNull()
  })

  it('does not mistake command_execution items for text', () => {
    expect(extractTextHeuristic(CODEX_COMMAND_STARTED, false)).toBeNull()
    expect(extractTextHeuristic(CODEX_COMMAND_COMPLETED, false)).toBeNull()
  })

  it('extracts agent_message text', () => {
    expect(extractTextHeuristic(CODEX_AGENT_MESSAGE, false)).toBe('codex cli test')
  })

  it('streams only the agent messages across a transcript with a tool call', () => {
    const lines = [
      CODEX_THREAD_STARTED,
      CODEX_TURN_STARTED,
      CODEX_AGENT_MESSAGE,
      CODEX_COMMAND_STARTED,
      CODEX_COMMAND_COMPLETED,
      CODEX_SECOND_AGENT_MESSAGE,
      CODEX_TURN_COMPLETED,
    ]
    let streamed = ''
    let gotAny = false
    for (const line of lines) {
      const text = extractTextHeuristic(line, gotAny)
      if (text !== null) {
        gotAny = true
        streamed += text
      }
    }
    expect(streamed).toBe('codex cli testhello-from-tool')
  })
})

const AGY_INIT = `{"event":"init","conversation_id":"c1","init":{"cwd":"/tmp","tools":["run_command"],"permission_mode":"always-proceed"}}`
const AGY_USER_INPUT_STEP = `{"event":"step_update","step_update":{"conversation_id":"c1","step_index":0,"state":"DONE","step_type":"user_input"}}`
const AGY_CHECKPOINT_STEP = `{"event":"step_update","step_update":{"conversation_id":"c1","step_index":1,"state":"DONE","step_type":"checkpoint","duration_seconds":2.1}}`
const AGY_AGENT_RESPONSE_NO_DELTA = `{"event":"step_update","step_update":{"conversation_id":"c1","step_index":2,"state":"DONE","step_type":"agent_response","duration_seconds":1.35,"usage":{"input_tokens":1,"output_tokens":1}}}`
const AGY_TOOL_STARTED_STEP = `{"event":"step_update","step_update":{"conversation_id":"c1","step_index":3,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"echo hi"}}}}`
const AGY_TOOL_DONE_STEP = `{"event":"step_update","step_update":{"conversation_id":"c1","step_index":3,"state":"DONE","step_type":"tool","tool_name":"run_command","duration_seconds":0.05,"tool_info":{"name":"run_command","output":"hi\\r\\n"}}}`
const AGY_DELTA_CHUNK_1 = `{"event":"step_update","step_update":{"conversation_id":"c1","step_index":4,"state":"ACTIVE","step_type":"agent_response","text_delta":"The output is:\\n\\n\`\`\`text\\nhello-fro"}}`
const AGY_DELTA_CHUNK_2 = `{"event":"step_update","step_update":{"conversation_id":"c1","step_index":4,"state":"ACTIVE","step_type":"agent_response","text_delta":"m-agy-tool\\n\`\`\`"}}`
const AGY_DELTA_CHUNK_3 = `{"event":"step_update","step_update":{"conversation_id":"c1","step_index":4,"state":"DONE","step_type":"agent_response","text_delta":"\\n","duration_seconds":4.2,"usage":{"input_tokens":1,"output_tokens":1}}}`
const AGY_RESULT = `{"event":"result","result":{"conversation_id":"c1","status":"SUCCESS","response":"The output is:\\n\\n\`\`\`text\\nhello-from-agy-tool\\n\`\`\`\\n","duration_seconds":7.7,"usage":{"input_tokens":1,"output_tokens":1}}}`

describe('Antigravity (agy) shape', () => {
  it('yields no text for non-content events', () => {
    expect(extractTextHeuristic(AGY_INIT, false)).toBeNull()
    expect(extractTextHeuristic(AGY_USER_INPUT_STEP, false)).toBeNull()
    expect(extractTextHeuristic(AGY_CHECKPOINT_STEP, false)).toBeNull()
    expect(extractTextHeuristic(AGY_AGENT_RESPONSE_NO_DELTA, false)).toBeNull()
  })

  it('does not mistake tool steps for text', () => {
    expect(extractTextHeuristic(AGY_TOOL_STARTED_STEP, false)).toBeNull()
    expect(extractTextHeuristic(AGY_TOOL_DONE_STEP, false)).toBeNull()
  })

  it('extracts a text_delta chunk', () => {
    expect(extractTextHeuristic(AGY_DELTA_CHUNK_1, false)).toBe('The output is:\n\n```text\nhello-fro')
  })

  it('suppresses result.response once deltas already streamed', () => {
    expect(extractTextHeuristic(AGY_RESULT, true)).toBeNull()
  })

  it('uses result.response as a fallback when nothing streamed yet', () => {
    expect(extractTextHeuristic(AGY_RESULT, false)).toBe('The output is:\n\n```text\nhello-from-agy-tool\n```\n')
  })

  it('streams the answer exactly once across a transcript with a tool call', () => {
    const lines = [
      AGY_INIT,
      AGY_USER_INPUT_STEP,
      AGY_CHECKPOINT_STEP,
      AGY_AGENT_RESPONSE_NO_DELTA,
      AGY_TOOL_STARTED_STEP,
      AGY_TOOL_DONE_STEP,
      AGY_DELTA_CHUNK_1,
      AGY_DELTA_CHUNK_2,
      AGY_DELTA_CHUNK_3,
      AGY_RESULT,
    ]
    let streamed = ''
    let gotAny = false
    for (const line of lines) {
      const text = extractTextHeuristic(line, gotAny)
      if (text !== null) {
        gotAny = true
        streamed += text
      }
    }
    expect(streamed).toBe('The output is:\n\n```text\nhello-from-agy-tool\n```\n')
  })
})

describe('edge cases', () => {
  it('returns null for blank lines', () => {
    expect(extractTextHeuristic('', false)).toBeNull()
    expect(extractTextHeuristic('   ', false)).toBeNull()
  })

  it('returns null for non-JSON lines', () => {
    expect(extractTextHeuristic('not json', false)).toBeNull()
  })
})
