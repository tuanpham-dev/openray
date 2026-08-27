/** HTTP client for Google's free translate endpoint
 * (translate.googleapis.com/translate_a/single) — no API key required.
 * Ported from `application/translate/client.rs`; isolated in this module
 * so a future provider swap only touches this file. */

const GTX_URL = 'https://translate.googleapis.com/translate_a/single'

export interface Translation {
  translatedText: string
  /** The source language gtx detected — meaningful when the request's
   * `source` was `"auto"`; `undefined` when `source` was already
   * explicit (nothing to detect). */
  detectedSource?: string
}

/** The stable `<kind>: <detail>` prefix a rejection carries — mirrors the
 * Rust client's convention exactly, so `ipc/translate.ts`'s
 * `parseTranslateError`-equivalent frontend logic (deleted along with the
 * rest of the native UI, T22) has a direct TS analogue if a future
 * consumer ever needs it, and so the extension's own toasts can show the
 * same three distinguishable failure kinds native did. */
export class TranslateClientError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TranslateClientError'
  }
}

interface GtxResponse {
  0?: unknown
  2?: unknown
}

/** The gtx response is `[[[translated, original, null, null, confidence], …], null, detectedSourceLang, …]`.
 * A stray non-string segment is skipped rather than failing the whole
 * translation — better a slightly short result than none at all. */
function parseResponse(body: unknown, source: string): Translation | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const segments = (body as GtxResponse)[0]
  if (!Array.isArray(segments) || segments.length === 0) return undefined

  const translatedText = segments
    .map((segment) => (Array.isArray(segment) && typeof segment[0] === 'string' ? segment[0] : ''))
    .join('')

  const detected = (body as GtxResponse)[2]
  const detectedSource = source === 'auto' && typeof detected === 'string' ? detected : undefined

  return detectedSource !== undefined ? { translatedText, detectedSource } : { translatedText }
}

/** One HTTPS GET via Node's global `fetch` — callers (the extension's
 * `onQuery`/view components) run this off React's render path already,
 * same invariant `client.rs`'s doc comment states for its own blocking
 * call. `fetchImpl` is overridable for tests only. */
export async function translate(text: string, source: string, target: string, fetchImpl: typeof fetch = fetch): Promise<Translation> {
  if (text.trim() === '') {
    return { translatedText: '' }
  }

  const url = new URL(GTX_URL)
  url.searchParams.set('client', 'gtx')
  url.searchParams.set('sl', source)
  url.searchParams.set('tl', target)
  url.searchParams.set('dt', 't')
  url.searchParams.set('q', text)

  let response: Response
  try {
    response = await fetchImpl(url.toString())
  } catch (error) {
    throw new TranslateClientError(`network: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (response.status === 429) {
    throw new TranslateClientError('rate_limited: translation service is rate-limiting requests')
  }
  if (!response.ok) {
    throw new TranslateClientError(`network: HTTP ${response.status}`)
  }

  let body: unknown
  try {
    body = await response.json()
  } catch (error) {
    throw new TranslateClientError(`parse: ${error instanceof Error ? error.message : String(error)}`)
  }

  const parsed = parseResponse(body, source)
  if (!parsed) throw new TranslateClientError('parse: unexpected response shape')
  return parsed
}
