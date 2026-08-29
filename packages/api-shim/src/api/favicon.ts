import { Cache } from './cache'
import { Icon } from './icon'

/** One cache for the whole shim — favicons are per-origin, not per-command. */
let cache: Cache | undefined
function faviconCache(): Cache {
  cache ??= new Cache({ namespace: 'openray.favicon' })
  return cache
}

export interface FaviconOptions {
  /** Returned when the site has no reachable favicon. */
  fallback?: string
  /** Accepted for signature parity; the size the site serves is used. */
  size?: number
  mask?: string
}

/**
 * An icon for a URL, as a `data:` URI.
 *
 * 12 of 180 sampled extensions use this — any list of links wants it, and
 * a stub meant every row showed the same generic glyph.
 *
 * Fetched from the site's **own** `/favicon.ico` rather than through a
 * third-party favicon service. The convenient services (Google's,
 * DuckDuckGo's) would mean shipping every URL an extension touches to a
 * third party, which for a bookmarks extension is the user's bookmark
 * list. One request to the site itself, cached per origin, avoids that.
 *
 * Failure is not exceptional here — plenty of sites have no favicon, and a
 * list of links must not break because one of them 404s — so any failure
 * resolves to the fallback icon instead of rejecting.
 */
export async function getFavicon(url: string, options?: FaviconOptions): Promise<string> {
  const fallback = options?.fallback ?? Icon.Globe
  let origin: string
  try {
    origin = new URL(url).origin
  } catch {
    return fallback
  }

  const cached = faviconCache().get(origin)
  if (cached !== undefined) {
    // A cached empty string records a previous failure, so a dead origin
    // isn't refetched once per render.
    return cached === '' ? fallback : cached
  }

  try {
    const response = await fetch(`${origin}/favicon.ico`, { redirect: 'follow' })
    if (!response.ok) {
      faviconCache().set(origin, '')
      return fallback
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length === 0) {
      faviconCache().set(origin, '')
      return fallback
    }
    const type = response.headers.get('content-type') ?? 'image/x-icon'
    const dataUri = `data:${type.split(';')[0]};base64,${buffer.toString('base64')}`
    faviconCache().set(origin, dataUri)
    return dataUri
  } catch {
    faviconCache().set(origin, '')
    return fallback
  }
}
