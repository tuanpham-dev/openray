import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { downloadArchive, fetchCatalog, parseCatalog, resolveEntryUrl } from '../src/registry'

const created: string[] = []
const servers: Server[] = []

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `openray-${prefix}-`))
  created.push(dir)
  return dir
}

/** A minimal static host, so the fetch path is exercised for real (ETag
 *  handling included) rather than through a mocked `fetch`. */
async function serve(routes: Record<string, { body: string | Buffer; etag?: string; status?: number }>): Promise<{
  url: string
  requests: string[]
  ifNoneMatch: (string | undefined)[]
}> {
  const requests: string[] = []
  const ifNoneMatch: (string | undefined)[] = []
  const server = createServer((request, response) => {
    requests.push(request.url ?? '')
    ifNoneMatch.push(request.headers['if-none-match'] as string | undefined)
    const route = routes[request.url ?? '']
    if (!route) {
      response.writeHead(404).end('not found')
      return
    }
    if (route.etag && request.headers['if-none-match'] === route.etag) {
      response.writeHead(304, { etag: route.etag }).end()
      return
    }
    response.writeHead(route.status ?? 200, { ...(route.etag ? { etag: route.etag } : {}) }).end(route.body)
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}/`, requests, ifNoneMatch }
}

const CATALOG = JSON.stringify({
  formatVersion: 1,
  name: 'Test Registry',
  extensions: [
    { name: 'alpha', title: 'Alpha', version: '1.0.0', file: 'alpha-1.0.0.orx', sha256: 'abc', icon: 'alpha-icon.png' },
    { name: 'beta', title: 'Beta', version: '2.0.0', file: 'https://cdn.test/beta-2.0.0.orx' },
    { title: 'No name, dropped', file: 'x.orx' },
  ],
})

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
  for (const server of servers.splice(0)) server.close()
})

describe('entry URL resolution', () => {
  it('resolves a relative path against the registry base', () => {
    expect(resolveEntryUrl('https://x.test/r', 'a.orx')).toBe('https://x.test/r/a.orx')
    expect(resolveEntryUrl('https://x.test/r/', 'a.orx')).toBe('https://x.test/r/a.orx')
  })

  it('leaves an absolute URL alone', () => {
    // The Releases-offload case: catalog on Pages, archives elsewhere. If
    // this ever "helpfully" rebased, a registry could never outgrow its
    // catalog host.
    expect(resolveEntryUrl('https://x.test/r/', 'https://github.test/releases/a.orx')).toBe('https://github.test/releases/a.orx')
  })

  it('treats a local directory as a registry', () => {
    expect(resolveEntryUrl('/srv/dist', 'a.orx')).toBe('/srv/dist/a.orx')
  })
})

describe('catalog parsing', () => {
  it('resolves entry paths and keeps absolute ones', () => {
    const catalog = parseCatalog(CATALOG, 'https://x.test/r/', false)
    expect(catalog.name).toBe('Test Registry')
    expect(catalog.extensions[0]?.file).toBe('https://x.test/r/alpha-1.0.0.orx')
    expect(catalog.extensions[0]?.icon).toBe('https://x.test/r/alpha-icon.png')
    expect(catalog.extensions[1]?.file).toBe('https://cdn.test/beta-2.0.0.orx')
  })

  it('drops an unusable entry instead of failing the whole catalog', () => {
    // One malformed row in someone's registry must not hide every other
    // extension in it.
    const catalog = parseCatalog(CATALOG, 'https://x.test/r/', false)
    expect(catalog.extensions.map((entry) => entry.name)).toEqual(['alpha', 'beta'])
  })

  it('refuses a catalog format from the future', () => {
    expect(() => parseCatalog(JSON.stringify({ formatVersion: 99, extensions: [] }), 'https://x.test/r/', false)).toThrow(
      /newer version of OpenRay/,
    )
  })

  it('rejects malformed JSON and non-catalogs with the source named', () => {
    expect(() => parseCatalog('{ nope', 'https://x.test/r/', false)).toThrow(/not valid JSON/)
    expect(() => parseCatalog('{}', 'https://x.test/r/', false)).toThrow(/no extensions array/)
  })
})

describe('fetching a catalog', () => {
  it('reads a local directory registry with no server involved', async () => {
    const dir = scratch('local-registry')
    writeFileSync(join(dir, 'index.json'), CATALOG)
    const catalog = await fetchCatalog(dir, scratch('cache'))
    expect(catalog.extensions).toHaveLength(2)
    expect(catalog.extensions[0]?.file).toBe(join(dir, 'alpha-1.0.0.orx'))
  })

  it('caches by ETag and re-reads the cache on a 304', async () => {
    const host = await serve({ '/index.json': { body: CATALOG, etag: '"v1"' } })
    const cacheDir = scratch('cache')

    const first = await fetchCatalog(host.url, cacheDir)
    expect(first.fromCache).toBe(false)

    const second = await fetchCatalog(host.url, cacheDir)
    expect(second.fromCache).toBe(true)
    expect(second.extensions).toHaveLength(2)
    // The second request must have offered the ETag, or the server has no
    // way to answer 304 and every Store open re-downloads.
    expect(host.ifNoneMatch[1]).toBe('"v1"')
  })

  it('falls back to the cached catalog when the registry is unreachable', async () => {
    const host = await serve({ '/index.json': { body: CATALOG, etag: '"v1"' } })
    const cacheDir = scratch('cache')
    await fetchCatalog(host.url, cacheDir)

    // Close the registry so the next fetch genuinely fails to connect —
    // this is the "user opens the Store on a train" path, and it has to
    // show what it has rather than an error.
    for (const server of servers.splice(0)) server.close()

    const offline = await fetchCatalog(host.url, cacheDir)
    expect(offline.fromCache).toBe(true)
    expect(offline.extensions).toHaveLength(2)
  })

  it('fails clearly when there is neither a registry nor a cache', async () => {
    const host = await serve({})
    await expect(fetchCatalog(host.url, scratch('cache'))).rejects.toThrow(/HTTP 404/)
  })
})

describe('downloading an archive', () => {
  it('verifies the catalog digest', async () => {
    const payload = Buffer.from('pretend this is an orx')
    const sha256 = createHash('sha256').update(payload).digest('hex')
    const host = await serve({ '/alpha.orx': { body: payload } })

    const file = await downloadArchive(`${host.url}alpha.orx`, sha256)
    expect(readFileSync(file)).toEqual(payload)
  })

  it('refuses a file whose digest does not match the catalog', async () => {
    // The case this exists for: catalog on one host, archive on another.
    const host = await serve({ '/alpha.orx': { body: Buffer.from('substituted') } })
    await expect(downloadArchive(`${host.url}alpha.orx`, createHash('sha256').update('expected').digest('hex'))).rejects.toThrow(
      /digest mismatch/,
    )
  })

  it('downloads without a digest when the catalog declares none', async () => {
    const host = await serve({ '/alpha.orx': { body: Buffer.from('no digest declared') } })
    const file = await downloadArchive(`${host.url}alpha.orx`)
    expect(readFileSync(file, 'utf-8')).toBe('no digest declared')
  })

  it('reads a local-directory registry archive', async () => {
    const dir = scratch('local-registry')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'alpha.orx'), 'local bytes')
    const file = await downloadArchive(join(dir, 'alpha.orx'))
    expect(readFileSync(file, 'utf-8')).toBe('local bytes')
  })
})
