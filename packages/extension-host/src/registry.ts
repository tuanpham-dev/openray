import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { log } from './rpc'

/**
 * A registry is a base URL (or a local directory) serving `index.json` and
 * one archive per extension. There is no API and no server side — which is
 * the whole point: publishing one is `git push` to any static host, and
 * OpenRay runs no infrastructure to make the store work.
 */
const CATALOG_FILE = 'index.json'

/** Entries a catalog lists. Everything but `name`/`file` is optional. */
interface CatalogEntry {
  name: string
  title: string
  description?: string
  author?: string
  version?: string
  apiVersion?: string
  /** Resolved to an absolute URL against the registry base. */
  file: string
  sha256?: string
  icon?: string
  readme?: string
  categories?: string[]
  /** Manifest `platforms`, when the extension declares any. */
  platforms?: string[]
}

export interface Catalog {
  formatVersion: number
  name?: string
  description?: string
  extensions: CatalogEntry[]
  /** The base this catalog was fetched from, normalized with a trailing slash. */
  sourceUrl: string
  /** True when the response was a 304 and this came from the on-disk cache. */
  fromCache: boolean
}

/** Only bumped when the *catalog* shape changes incompatibly. */
const SUPPORTED_CATALOG_VERSION = 1

function normalizeBase(url: string): string {
  const trimmed = url.trim()
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`
}

/**
 * Resolves a catalog entry's path against the registry base — **unless it
 * is already absolute**, which is deliberate: it lets a registry keep its
 * catalog on one host and its archives on another. GitHub Pages has a
 * 100 GB/month bandwidth limit while Releases assets have none, so the
 * obvious escape hatch for a popular registry is to publish `index.json`
 * on Pages with `file` pointing at Releases, and that must not require an
 * app change.
 */
export function resolveEntryUrl(base: string, path: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return path
  const normalizedBase = normalizeBase(base)
  if (isLocalPath(normalizedBase)) return join(normalizedBase, path)
  return new URL(path, normalizedBase).toString()
}

/** A local directory is a perfectly good registry — `dist/` straight out
 *  of a packer, or a shared folder — and needs no HTTP server. */
function isLocalPath(base: string): boolean {
  return base.startsWith('/') || /^[a-z]:[\\/]/i.test(base)
}

interface CachedCatalog {
  etag?: string
  body: string
}

async function readCache(cacheDir: string, url: string): Promise<CachedCatalog | null> {
  const path = cachePath(cacheDir, url)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as CachedCatalog
  } catch {
    return null
  }
}

function cachePath(cacheDir: string, url: string): string {
  return join(cacheDir, `${createHash('sha256').update(normalizeBase(url)).digest('hex').slice(0, 32)}.json`)
}

/**
 * Fetches and validates a registry's catalog.
 *
 * Conditional on the cached ETag, so opening the Store repeatedly (or an
 * hourly update check) costs a 304 rather than a full download — the
 * courtesy any static host deserves from a client that polls. A cached copy
 * is also what makes the Store readable offline; the caller decides whether
 * to say so.
 */
export async function fetchCatalog(sourceUrl: string, cacheDir: string): Promise<Catalog> {
  const base = normalizeBase(sourceUrl)

  if (isLocalPath(base)) {
    const raw = await readFile(join(base, CATALOG_FILE), 'utf-8')
    return parseCatalog(raw, base, false)
  }

  await mkdir(cacheDir, { recursive: true })
  const cached = await readCache(cacheDir, base)
  const headers: Record<string, string> = { accept: 'application/json' }
  if (cached?.etag) headers['if-none-match'] = cached.etag

  let response: Response
  try {
    response = await fetch(new URL(CATALOG_FILE, base), { headers, redirect: 'follow' })
  } catch (error) {
    // Offline: a cached catalog is still worth showing, flagged as stale.
    if (cached) {
      log(`registry ${base}: unreachable, using cached catalog`)
      return parseCatalog(cached.body, base, true)
    }
    throw new Error(`could not reach ${base}: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (response.status === 304 && cached) {
    return parseCatalog(cached.body, base, true)
  }
  if (!response.ok) {
    if (cached) {
      log(`registry ${base}: HTTP ${response.status}, using cached catalog`)
      return parseCatalog(cached.body, base, true)
    }
    throw new Error(`${base}${CATALOG_FILE} returned HTTP ${response.status}`)
  }

  const body = await response.text()
  const catalog = parseCatalog(body, base, false)
  const etag = response.headers.get('etag')
  await writeFile(cachePath(cacheDir, base), JSON.stringify({ ...(etag ? { etag } : {}), body } satisfies CachedCatalog))
  return catalog
}

/**
 * Parses and validates catalog JSON. Entries missing the two fields that
 * make them installable (`name`, `file`) are dropped rather than failing
 * the whole catalog — one malformed row in someone's registry shouldn't
 * hide every other extension in it.
 */
export function parseCatalog(raw: string, sourceUrl: string, fromCache: boolean): Catalog {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`${sourceUrl}${CATALOG_FILE} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!parsed || typeof parsed !== 'object') throw new Error(`${sourceUrl}${CATALOG_FILE} is not a catalog`)

  const record = parsed as Record<string, unknown>
  const formatVersion = typeof record.formatVersion === 'number' ? record.formatVersion : 1
  if (formatVersion > SUPPORTED_CATALOG_VERSION) {
    throw new Error(`${sourceUrl} uses catalog format ${formatVersion}, which needs a newer version of OpenRay`)
  }
  if (!Array.isArray(record.extensions)) {
    throw new Error(`${sourceUrl}${CATALOG_FILE} has no extensions array`)
  }

  const base = normalizeBase(sourceUrl)
  const extensions: CatalogEntry[] = []
  for (const candidate of record.extensions) {
    if (!candidate || typeof candidate !== 'object') continue
    const entry = candidate as Record<string, unknown>
    if (typeof entry.name !== 'string' || typeof entry.file !== 'string') continue
    extensions.push({
      name: entry.name,
      title: typeof entry.title === 'string' ? entry.title : entry.name,
      ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
      ...(typeof entry.author === 'string' ? { author: entry.author } : {}),
      ...(typeof entry.version === 'string' ? { version: entry.version } : {}),
      ...(typeof entry.apiVersion === 'string' ? { apiVersion: entry.apiVersion } : {}),
      file: resolveEntryUrl(base, entry.file),
      ...(typeof entry.sha256 === 'string' ? { sha256: entry.sha256.toLowerCase() } : {}),
      ...(typeof entry.icon === 'string' ? { icon: resolveEntryUrl(base, entry.icon) } : {}),
      ...(typeof entry.readme === 'string' ? { readme: resolveEntryUrl(base, entry.readme) } : {}),
      ...(Array.isArray(entry.categories) ? { categories: entry.categories.filter((c): c is string => typeof c === 'string') } : {}),
      ...(Array.isArray(entry.platforms) ? { platforms: entry.platforms.filter((p): p is string => typeof p === 'string') } : {}),
    })
  }

  return {
    formatVersion,
    ...(typeof record.name === 'string' ? { name: record.name } : {}),
    ...(typeof record.description === 'string' ? { description: record.description } : {}),
    extensions,
    sourceUrl: base,
    fromCache,
  }
}

/**
 * Downloads an archive to a temp file, verifying its digest when the
 * catalog declared one.
 *
 * The check matters most in exactly the arrangement `resolveEntryUrl`
 * allows: catalog and archives on different hosts. It pins archive to
 * catalog — it says nothing about *who* published either, which is what
 * signing would add and this deliberately does not claim.
 */
export async function downloadArchive(url: string, expectedSha256?: string): Promise<string> {
  let bytes: Uint8Array
  if (url.startsWith('file://')) {
    bytes = new Uint8Array(await readFile(new URL(url)))
  } else if (isLocalPath(url)) {
    bytes = new Uint8Array(await readFile(url))
  } else {
    const response = await fetch(url, { redirect: 'follow' })
    if (!response.ok) throw new Error(`downloading ${url} returned HTTP ${response.status}`)
    bytes = new Uint8Array(await response.arrayBuffer())
  }

  if (expectedSha256) {
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== expectedSha256.toLowerCase()) {
      throw new Error(`archive digest mismatch for ${url} — the catalog expects ${expectedSha256}, the file is ${actual}`)
    }
  }

  const dir = await mkdtemp(join(tmpdir(), 'openray-download-'))
  const file = join(dir, basename(new URL(url, pathToFileURL(`${process.cwd()}/`)).pathname) || 'extension.orx')
  await writeFile(file, bytes)
  return file
}
