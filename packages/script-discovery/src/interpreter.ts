// Port of src-tauri/src/application/script_commands.rs's
// `resolve_interpreter` — the Unix branch only. This build only ever
// compiled/ran the Linux half of the native module (confirmed by every
// prior T17/T18 port's own "Linux-only, deliberately" scope decision);
// the Windows-specific table (`.ps1`/`.bat`/`.cmd` native hosts, shebang
// *path* discarded since it's meaningless there) was dead code on this
// build target and is out of scope here too.

import { statSync } from 'node:fs'
import { extname } from 'node:path'

// Not lowercased — matches native's Unix branch exactly, which compares
// the raw extension (only the *Windows* branch lowercases first).
const EXTENSION_INTERPRETERS: Record<string, string> = {
  '.py': 'python3',
  '.js': 'node',
  '.mjs': 'node',
  '.rb': 'ruby',
  '.pl': 'perl',
  '.php': 'php',
  '.fish': 'fish',
  '.zsh': 'zsh',
  // AppleScript and Swift scripts, Raycast's other first-class
  // languages. osascript ships with macOS; harmless (just unresolved)
  // elsewhere.
  '.applescript': 'osascript',
  '.scpt': 'osascript',
  '.swift': 'swift',
}

/** An executable file runs as itself (its own shebang applies via the
 * kernel); otherwise the shebang line is parsed manually; otherwise an
 * interpreter is inferred from the extension — Raycast requires the
 * executable bit, but scripts synced from another machine routinely
 * lose it and there's no reason to fail on that. */
export function resolveInterpreter(path: string, sourceFirstLine: string): { program: string; args: string[] } {
  try {
    const mode = statSync(path).mode
    if ((mode & 0o111) !== 0) {
      return { program: path, args: [] }
    }
  } catch {
    // A failed stat degrades to "not executable" here, same as native's
    // `.unwrap_or(false)` — fall through to the shebang/extension path.
  }

  if (sourceFirstLine.startsWith('#!')) {
    const parts = sourceFirstLine
      .slice(2)
      .split(/\s+/)
      .filter((p) => p !== '')
    const program = parts[0]
    if (program !== undefined) {
      return { program, args: [...parts.slice(1), path] }
    }
  }

  const program = EXTENSION_INTERPRETERS[extname(path)] ?? 'bash'
  return { program, args: [path] }
}
