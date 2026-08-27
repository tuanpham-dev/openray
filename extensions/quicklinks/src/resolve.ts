import { homedir } from 'node:os'
import { Clipboard, getSelectedText } from '@raycast/api'
import { argumentSpecs, expand, type Context } from '@openray/placeholders'

/** Raycast's spelling is `{argument}` (with optional attributes, handled
 *  by the placeholder parser); `{query}` is what this app shipped with
 *  and what existing quicklinks contain, kept as a bare-token alias. */
const LEGACY_QUERY_PLACEHOLDER = '{query}'

export function takesArgument(urlTemplate: string): boolean {
  return urlTemplate.includes(LEGACY_QUERY_PLACEHOLDER) || argumentSpecs(urlTemplate).length > 0
}

/** Makes a user-entered link openable. `open()` needs a scheme; a bare
 *  `github.com` — the natural thing to type — would otherwise fail or be
 *  treated as a relative path. Absolute paths become `file://` so a
 *  quicklink can point at a folder, and anything already carrying a
 *  scheme is left untouched. */
function normalizeUrl(url: string): string {
  const trimmed = url.trim()

  if (trimmed.startsWith('/')) return `file://${trimmed}`
  if (trimmed.startsWith('~')) {
    const home = homedir()
    if (home) return `file://${home}${trimmed.slice(1)}`
  }

  const isSchemeChar = (c: string) => /[A-Za-z0-9+.-]/.test(c)
  const isAlpha = (c: string) => /[A-Za-z]/.test(c)

  const doubleSlashAt = trimmed.indexOf('://')
  const scheme = doubleSlashAt === -1 ? '' : trimmed.slice(0, doubleSlashAt)
  const hasScheme = doubleSlashAt > 0 && [...scheme].every(isSchemeChar)

  // `mailto:`/`tel:` and friends have no `//` but are still schemes.
  const colonAt = trimmed.indexOf(':')
  const opaqueScheme = colonAt === -1 ? '' : trimmed.slice(0, colonAt)
  const afterColon = colonAt === -1 ? '' : trimmed.slice(colonAt + 1)
  const hasOpaqueScheme = colonAt > 0 && !afterColon.startsWith('/') && [...opaqueScheme].every(isAlpha)

  if (hasScheme || hasOpaqueScheme) return trimmed
  return `https://${trimmed}`
}

/** Substitutes the argument and dynamic placeholders, then normalises the
 *  result into an openable URL. Every substituted value is
 *  percent-encoded (unless the token carries `| raw`) — it lands inside a
 *  URL, and an unencoded space or `&` would truncate or corrupt the
 *  query. */
export async function resolveUrl(template: string, argument: string): Promise<string> {
  const encodedArgument = encodeURIComponent(argument)
  const withLegacyQuery = template.split(LEGACY_QUERY_PLACEHOLDER).join(encodedArgument)

  const ctx: Context = {
    clipboard: async (offset) => (await Clipboard.readText({ offset })) ?? '',
    selection: async () => {
      try {
        return await getSelectedText()
      } catch {
        return ''
      }
    },
  }
  if (argument !== '') ctx.argument = argument

  const expanded = await expand(withLegacyQuery, ctx, (value) => encodeURIComponent(value))
  return normalizeUrl(expanded)
}
