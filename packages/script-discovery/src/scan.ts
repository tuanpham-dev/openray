// Port of src-tauri/src/application/script_commands.rs's
// `discover_scripts`/`scan_directory`, plus `infrastructure/paths.rs`'s
// `expand_home` (only `~/...` expands; a bare `~` passes through
// untouched — a deliberately preserved quirk, not a bug to fix here).

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseScriptMetadata, type ScriptCommand } from './metadata'

const MAX_SCAN_DEPTH = 3

export function expandHome(path: string): string {
  if (path.startsWith('~/') || path.startsWith('~\\')) {
    return join(homedir(), path.slice(2))
  }
  return path
}

function scanDirectory(dir: string, depth: number, out: ScriptCommand[]): void {
  if (depth > MAX_SCAN_DEPTH) return
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (name.startsWith('.') || name === 'node_modules') continue
    const path = join(dir, name)
    let isDirectory: boolean
    try {
      isDirectory = statSync(path).isDirectory()
    } catch {
      continue
    }
    if (isDirectory) {
      scanDirectory(path, depth + 1, out)
      continue
    }
    try {
      const source = readFileSync(path, 'utf-8')
      const script = parseScriptMetadata(source, path)
      if (script) out.push(script)
    } catch {
      // Unreadable (binary, permission-denied, …) — skip, matching
      // native's `Ok(source) = std::fs::read_to_string(...)` guard.
    }
  }
}

export function discoverScripts(directories: string[]): ScriptCommand[] {
  const scripts: ScriptCommand[] = []
  for (const dir of directories) {
    scanDirectory(expandHome(dir), 0, scripts)
  }
  // A plain codepoint comparison, not `localeCompare` — matches Rust's
  // byte-wise `String::cmp` ordering rather than locale-aware sorting.
  scripts.sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0))
  return scripts
}
