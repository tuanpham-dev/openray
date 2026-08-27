// Port of src-tauri/src/application/script_commands.rs's
// `parse_script_metadata`. Raycast script commands are annotated with
// `@raycast.*` comment headers — see that module's own doc comment for
// the canonical example this parser must keep accepting unmodified.

export type ScriptMode = 'fullOutput' | 'compact' | 'silent' | 'inline'

function parseScriptMode(value: string): ScriptMode | undefined {
  if (value === 'fullOutput' || value === 'compact' || value === 'silent' || value === 'inline') return value
  return undefined
}

/** `kind`/`placeholder`/`secure` are parsed for spec completeness but not
 * yet surfaced — matches native's own `#[allow(dead_code)]` fields. */
export interface ScriptArgument {
  kind: string
  placeholder: string
  optional: boolean
  percentEncoded: boolean
  secure: boolean
}

export interface ScriptCommand {
  path: string
  title: string
  mode: ScriptMode
  packageName?: string
  icon?: string
  description?: string
  arguments: ScriptArgument[]
  currentDirectoryPath?: string
  /** Parsed but not yet enforced by native — this port DOES enforce it
   * (see list.ts's `needsConfirm`), a deliberate fidelity improvement,
   * not scope creep: the generic root-provider confirm mechanism (T14)
   * is already free once the flag is threaded through. */
  needsConfirmation: boolean
}

function parseArgument(json: string): ScriptArgument | undefined {
  try {
    const raw: unknown = JSON.parse(json)
    if (typeof raw !== 'object' || raw === null) return undefined
    const record = raw as Record<string, unknown>
    return {
      kind: typeof record.type === 'string' ? record.type : '',
      placeholder: typeof record.placeholder === 'string' ? record.placeholder : '',
      optional: record.optional === true,
      percentEncoded: record.percentEncoded === true,
      secure: record.secure === true,
    }
  } catch {
    return undefined
  }
}

const COMMENT_PREFIX_CHARS = new Set(['#', '/', '-', '*', ' ', '\t'])

/** Returns `undefined` unless the file declares `schemaVersion 1`, a
 * non-empty `title`, and a valid `mode` — Raycast's own minimum for a
 * script to appear at all. `path` is the script's own path, kept as the
 * command id (stable across rescans). */
export function parseScriptMetadata(source: string, path: string): ScriptCommand | undefined {
  let schemaOk = false
  let title: string | undefined
  let mode: ScriptMode | undefined
  let packageName: string | undefined
  let icon: string | undefined
  let description: string | undefined
  let currentDirectoryPath: string | undefined
  let needsConfirmation = false
  const argumentSlots: (ScriptArgument | undefined)[] = [undefined, undefined, undefined]

  const lines = source.split('\n').slice(0, 200)
  for (const line of lines) {
    const at = line.indexOf('@raycast.')
    if (at === -1) continue
    // Headers live in comments; require only comment-ish characters
    // before the marker so a code line mentioning the literal string
    // (like this parser's own source) isn't misread as a header.
    const before = line.slice(0, at).trimStart()
    if (![...before].every((c) => COMMENT_PREFIX_CHARS.has(c))) continue

    const rest = line.slice(at + '@raycast.'.length)
    const whitespaceMatch = rest.match(/\s/)
    const key = whitespaceMatch ? rest.slice(0, whitespaceMatch.index) : rest.trim()
    const value = whitespaceMatch ? rest.slice((whitespaceMatch.index ?? 0) + 1).trim() : ''

    switch (key) {
      case 'schemaVersion':
        schemaOk = value === '1'
        break
      case 'title':
        if (value !== '') title = value
        break
      case 'mode':
        mode = parseScriptMode(value)
        break
      case 'packageName':
        if (value !== '') packageName = value
        break
      case 'icon':
        if (value !== '') icon = value
        break
      case 'description':
        if (value !== '') description = value
        break
      case 'currentDirectoryPath':
        if (value !== '') currentDirectoryPath = value
        break
      case 'needsConfirmation':
        needsConfirmation = value === 'true'
        break
      case 'argument1':
      case 'argument2':
      case 'argument3': {
        const slot = Number(key[key.length - 1]) - 1
        argumentSlots[slot] = parseArgument(value)
        break
      }
      default:
        break
    }
  }

  if (!schemaOk || title === undefined || mode === undefined) return undefined

  // Arguments are positional; stop at the first gap so $1/$2/$3 line up
  // with what the script expects.
  const args: ScriptArgument[] = []
  for (const arg of argumentSlots) {
    if (!arg) break
    args.push(arg)
  }

  return {
    path,
    title,
    mode,
    arguments: args,
    needsConfirmation,
    ...(packageName !== undefined ? { packageName } : {}),
    ...(icon !== undefined ? { icon } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(currentDirectoryPath !== undefined ? { currentDirectoryPath } : {}),
  }
}
