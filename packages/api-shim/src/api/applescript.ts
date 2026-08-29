import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface AppleScriptOptions {
  /** `false` switches osascript to its machine-readable form (`-ss`). */
  humanReadableOutput?: boolean
  language?: 'AppleScript' | 'JavaScript'
  signal?: AbortSignal
  /** Milliseconds; `0` or absent means no limit. */
  timeout?: number
}

/**
 * The `osascript` argument list for a script file.
 *
 * Split out from the execution so the flag mapping can be tested off
 * macOS — the only part of this module that is testable here at all.
 */
export function osascriptArgs(scriptPath: string, args: string[], options?: AppleScriptOptions): string[] {
  const argv: string[] = []
  if (options?.language === 'JavaScript') argv.push('-l', 'JavaScript')
  // Raycast's default is human-readable; `-ss` is what turns that off.
  if (options?.humanReadableOutput === false) argv.push('-ss')
  argv.push(scriptPath, ...args)
  return argv
}

/** Thrown rather than silently doing nothing when there's no osascript. */
export class UnsupportedPlatformError extends Error {
  constructor() {
    super('runAppleScript is only available on macOS')
    this.name = 'UnsupportedPlatformError'
  }
}

/**
 * Runs an AppleScript (or JXA) script via `osascript`.
 *
 * 14 of 180 sampled extensions call this — the single most-used API left
 * unimplemented, and the only one whose absence is a *platform* fact
 * rather than a gap: it can work on a macOS build and can never work on
 * Linux. So it ships as a real implementation guarded by a platform check
 * with an honest error, instead of a stub that swallows the call
 * everywhere.
 *
 * No host bridge involved: the extension host is a real Node process, so
 * it can spawn `osascript` itself — the same way `file-search` and
 * `script-commands` already spawn processes.
 *
 * The script goes to a temp file rather than `osascript -e`: real
 * extension scripts are multi-line, and `-e` quoting mangles them.
 */
export function runAppleScript(script: string, options?: AppleScriptOptions): Promise<string>
export function runAppleScript(script: string, args: string[], options?: AppleScriptOptions): Promise<string>
export async function runAppleScript(
  script: string,
  argsOrOptions?: string[] | AppleScriptOptions,
  maybeOptions?: AppleScriptOptions,
): Promise<string> {
  const args = Array.isArray(argsOrOptions) ? argsOrOptions : []
  const options = Array.isArray(argsOrOptions) ? maybeOptions : argsOrOptions

  if (process.platform !== 'darwin') {
    throw new UnsupportedPlatformError()
  }

  const dir = await mkdtemp(join(tmpdir(), 'openray-osascript-'))
  const scriptPath = join(dir, options?.language === 'JavaScript' ? 'script.js' : 'script.applescript')
  await writeFile(scriptPath, script, 'utf-8')

  try {
    return await new Promise<string>((resolve, reject) => {
      const child = execFile(
        'osascript',
        osascriptArgs(scriptPath, args, options),
        { timeout: options?.timeout ?? 0, maxBuffer: 1024 * 1024 * 16 },
        (error, stdout, stderr) => {
          if (error) {
            // osascript reports compilation and runtime failures on
            // stderr; surfacing that beats the generic "exited with 1".
            reject(new Error(stderr.trim() || error.message))
            return
          }
          // Raycast trims the trailing newline osascript always adds.
          resolve(stdout.replace(/\n$/, ''))
        },
      )
      options?.signal?.addEventListener('abort', () => child.kill(), { once: true })
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
