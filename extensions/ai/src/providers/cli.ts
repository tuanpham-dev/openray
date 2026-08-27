/**
 * Local agent CLIs: Claude Code, Codex, Antigravity (`agy`), and
 * user-defined custom commands — port of
 * `src-tauri/src/application/ai/providers/cli.rs`. Model ids:
 * `cli:claude-code`, `cli:codex`, `cli:antigravity`, `cli:custom:<name>`.
 *
 * **Simplification (disclosed, matching native):** no true multi-turn
 * session resume — every call flattens the full transcript into one
 * prompt string.
 *
 * Each child is spawned with `stdin` explicitly closed (matching native's
 * `Stdio::null()` — `agy`'s documented non-TTY hang/silent-stdout bugs
 * are exactly this failure mode) and its stdout read line-by-line, run
 * through `extractTextHeuristic` (`@openray/ai-core`).
 */
import { spawn } from 'node:child_process'
import * as readline from 'node:readline'
import { extractTextHeuristic, splitModelId } from '@openray/ai-core'
import type { ChatMessage, ChatProvider, ChatTurn, StreamEvent } from './types'

function flattenTranscript(system: string | undefined, messages: ChatMessage[]): string {
  let out = ''
  if (system) out += `${system}\n\n`
  for (const message of messages) {
    const label = message.role === 'assistant' ? 'Assistant' : 'User'
    out += `${label}: ${message.content}\n`
  }
  return out
}

export const cliProvider: ChatProvider = {
  async stream(turn: ChatTurn, onEvent: (event: StreamEvent) => void): Promise<void> {
    const [, rest] = splitModelId(turn.model)
    const prompt = flattenTranscript(turn.system, turn.messages)

    let program: string
    let args: string[]
    let ndjson: boolean
    if (rest === 'claude-code') {
      program = 'claude'
      args = ['-p', prompt, '--output-format', 'stream-json', '--verbose']
      ndjson = true
    } else if (rest === 'codex') {
      program = 'codex'
      args = ['exec', '--json', '--skip-git-repo-check', prompt]
      ndjson = true
    } else if (rest === 'antigravity') {
      program = 'agy'
      args = ['-p', prompt, '--output-format', 'stream-json']
      ndjson = true
    } else if (rest.startsWith('custom:')) {
      const template = turn.cliCommand
      if (!template || template.length === 0) throw new Error('parse: no command configured for this custom CLI')
      program = template[0]!
      args = template.slice(1).map((arg) => arg.replaceAll('{prompt}', prompt))
      ndjson = false
    } else {
      throw new Error(`parse: unknown CLI preset '${rest}'`)
    }

    await new Promise<void>((resolve, reject) => {
      const child = spawn(program, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let gotAnyOutput = false
      let stderrText = ''
      let spawnError: Error | undefined

      child.stderr.on('data', (chunk: Buffer) => {
        stderrText += chunk.toString()
      })

      const rl = readline.createInterface({ input: child.stdout })
      rl.on('line', (line) => {
        const text = ndjson ? extractTextHeuristic(line, gotAnyOutput) : line
        if (text) {
          gotAnyOutput = true
          onEvent({ kind: 'delta', text })
        }
      })

      child.on('error', (err) => {
        spawnError = new Error(`network: failed to launch '${program}': ${err.message}`)
      })

      child.on('close', (code) => {
        if (spawnError) {
          reject(spawnError)
        } else if (code !== 0 && !gotAnyOutput) {
          reject(new Error(`network: '${program}' exited with code ${code}: ${stderrText.trim()}`))
        } else {
          resolve()
        }
      })
    })
  },
}
