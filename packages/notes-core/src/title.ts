/**
 * Port of `application::notes::derive_title`/`strip_leading_markdown`
 * (`src-tauri/src/application/notes/mod.rs`) — a note's title is never
 * stored, always derived from its first non-empty content line on read.
 */

function stripLeadingMarkdown(line: string): string {
  // Heading: any run of leading '#' followed by a space.
  const headingMatch = /^#+ (.*)$/.exec(line)
  if (headingMatch) return headingMatch[1] ?? ''
  if (line.length > 0 && [...line].every((c) => c === '#')) return ''

  if (line.startsWith('> ')) return line.slice(2)

  for (const marker of ['- [ ] ', '- [x] ', '- [X] ', '* [ ] ', '* [x] ', '* [X] ']) {
    if (line.startsWith(marker)) return line.slice(marker.length)
  }

  if (line.startsWith('- ')) return line.slice(2)
  if (line.startsWith('* ')) return line.slice(2)

  // Ordered list: leading digits immediately followed by ". ".
  const dot = line.indexOf('. ')
  if (dot > 0) {
    const head = line.slice(0, dot)
    if (/^\d+$/.test(head)) return line.slice(dot + 2)
  }

  return line
}

/**
 * The first non-empty line of `content`, with one leading markdown block
 * marker stripped so the title reads as plain text instead of e.g.
 * `"# Meeting notes"`. Falls back to `"New Note"` for empty content or a
 * marker with no text after it (a lone `"#"`, a lone `"- [ ]"`).
 */
export function deriveTitle(content: string): string {
  const firstLine = content
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (!firstLine) return 'New Note'

  const stripped = stripLeadingMarkdown(firstLine).trim()
  return stripped.length > 0 ? stripped : 'New Note'
}
