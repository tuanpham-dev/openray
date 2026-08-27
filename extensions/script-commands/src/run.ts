// Port of src-tauri/src/application/script_commands.rs's `run_script`
// execution + argument/cwd resolution (the `ScriptCommandProvider::run`
// half). Mode-specific dispatch (toast vs. Detail vs. silent) lives in
// list.ts — this module only runs the child process and reports what
// happened.

import { spawn } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { resolveInterpreter, expandHome, type ScriptCommand } from '@openray/script-discovery'

export interface ScriptRunResult {
  stdout: string
  stderr: string
  /** `false` on a non-zero exit *or* a spawn-level failure (e.g. the
   * interpreter binary doesn't exist) — `error` distinguishes the two. */
  success: boolean
  error?: string
}

export interface RunScriptOptions {
  /** Fired for every stdout/stderr chunk as it arrives — the hook
   * `extensions/script-commands/src/list.ts`'s `View` component uses to
   * update a mounted Detail's markdown live as the script runs. Buffered
   * (compact/inline/silent) callers simply don't pass this. */
  onData?: (chunk: { stdout?: string; stderr?: string }) => void
}

export function lastLine(text: string): string | undefined {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim()
    if (trimmed !== '') return trimmed
  }
  return undefined
}

function resolveCwd(script: ScriptCommand): string {
  if (script.currentDirectoryPath) {
    const expanded = expandHome(script.currentDirectoryPath)
    try {
      if (statSync(expanded).isDirectory()) return expanded
    } catch {
      // Not a real directory — fall through to the script's own folder,
      // matching native's `.filter(|p| p.is_dir())`.
    }
  }
  return dirname(script.path)
}

function resolveArgv(script: ScriptCommand, argument: string | undefined): string[] {
  if (!argument) return []
  const firstArgSpec = script.arguments[0]
  const value = firstArgSpec?.percentEncoded ? encodeURIComponent(argument) : argument
  return [value]
}

/** Runs `script`'s interpreter+argv, resolving once the process exits
 * (or fails to spawn at all). Never rejects — a spawn failure resolves
 * with `success: false` and `error` set, mirroring native's own
 * `Err(e)` branch in `run_script`. */
export function runScript(script: ScriptCommand, argument: string | undefined, options: RunScriptOptions = {}): Promise<ScriptRunResult> {
  const firstLine = (() => {
    try {
      return readFileSync(script.path, 'utf-8').split('\n')[0] ?? ''
    } catch {
      return ''
    }
  })()
  const { program, args } = resolveInterpreter(script.path, firstLine)
  const argv = [...args, ...resolveArgv(script, argument)]
  const cwd = resolveCwd(script)

  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(program, argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ stdout: '', stderr: '', success: false, error: error instanceof Error ? error.message : String(error) })
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8')
      stdout += text
      options.onData?.({ stdout: text })
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8')
      stderr += text
      options.onData?.({ stderr: text })
    })
    child.once('error', (error) => {
      if (settled) return
      settled = true
      resolve({ stdout, stderr, success: false, error: `${program}: ${error.message}` })
    })
    child.once('close', (code) => {
      if (settled) return
      settled = true
      resolve({ stdout, stderr, success: code === 0 })
    })
  })
}
