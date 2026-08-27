/**
 * Fetches a URL and strips it to plain text for `{webpage}` — port of
 * `src-tauri/src/application/ai/webpage.rs`. The stripping itself lives
 * in `@openray/ai-core` (pure, testable); this is just the fetch.
 */
import { stripTags, withScheme, WEBPAGE_USER_AGENT } from '@openray/ai-core'

export async function fetchWebpageText(url: string): Promise<string> {
  const response = await fetch(withScheme(url), { headers: { 'User-Agent': WEBPAGE_USER_AGENT } })
  if (!response.ok) throw new Error(`network: ${response.status} ${response.statusText}`)
  const html = await response.text()
  return stripTags(html)
}
