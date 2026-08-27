/**
 * HTML → plain text for the built-in "Summarize Webpage"/"Ask About
 * Webpage" AI Commands' `{webpage}` placeholder. Port of
 * `src-tauri/src/application/ai/webpage.rs`'s `strip_tags`/`with_scheme` —
 * a hand-rolled tag-stripper rather than an HTML-parsing dependency, good
 * enough for prose-heavy pages.
 */

export const WEBPAGE_MAX_CHARS = 20_000

/** A real browser UA — plenty of sites with basic bot protection 403 or
 *  serve a near-empty challenge page to non-browser user agents. */
export const WEBPAGE_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/** Defaults a scheme-less URL to `https://` — the natural thing to type
 *  into an "Enter URL…" capture field with no example shown. */
export function withScheme(url: string): string {
  if (url.startsWith('http://') || url.startsWith('https://')) return url
  return `https://${url}`
}

export function stripTags(html: string): string {
  let out = ''
  let inTag = false
  let inSkipBlock = false
  let tagName = ''

  for (const c of html) {
    if (c === '<') {
      inTag = true
      tagName = ''
    } else if (c === '>' && inTag) {
      inTag = false
      const lower = tagName.toLowerCase()
      if (lower.startsWith('script') || lower.startsWith('style')) {
        inSkipBlock = !lower.startsWith('/')
      } else if (lower.startsWith('/script') || lower.startsWith('/style')) {
        inSkipBlock = false
      }
    } else if (inTag) {
      tagName += c
    } else if (inSkipBlock) {
      // skip
    } else {
      out += c
    }
    if (out.length > WEBPAGE_MAX_CHARS * 4) break
  }

  const collapsed = out.split(/\s+/).filter(Boolean).join(' ')
  return collapsed.slice(0, WEBPAGE_MAX_CHARS)
}
