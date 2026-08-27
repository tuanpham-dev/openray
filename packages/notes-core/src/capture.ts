/**
 * Port of `application::notes::parse_capture`/`strip_capture_prefix`
 * (`src-tauri/src/application/notes/mod.rs`) — the quick-capture root-search
 * intent (`"note buy milk"`), independent of whatever alias the user has
 * assigned to the Notes command (`"nt buy milk"`).
 */
const CAPTURE_PREFIX = 'note'

function stripCapturePrefix(query: string, prefix: string): string | undefined {
  if (prefix.length === 0 || !query.toLowerCase().startsWith(prefix.toLowerCase())) return undefined
  const rest = query.slice(prefix.length)
  if (!rest.startsWith(' ')) return undefined
  const text = rest.slice(1).trim()
  return text.length > 0 ? text : undefined
}

/**
 * Parses `query` for a leading `"note <text>"` (or `"<alias> <text>"`, when
 * the capture command has a user-assigned alias) and returns the captured
 * text. A bare prefix with no following text (`"note"`, `"nt"`) yields
 * `undefined` rather than empty-content note.
 */
export function parseCapture(query: string, alias?: string): string | undefined {
  const trimmed = query.trim()
  return stripCapturePrefix(trimmed, CAPTURE_PREFIX) ?? (alias ? stripCapturePrefix(trimmed, alias) : undefined)
}
