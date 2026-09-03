import { createElement } from 'react'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { _resetNodeIdsForTests, mount } from '../src/reconciler'
import { setCacheRootDirectory } from '../src/api/cache'
import { useCachedPromise, useFetch } from '../src/utils-hooks'
import { flush } from './flush'

/**
 * `useFetch` and `useCachedPromise` are what most real Raycast extensions
 * use to load anything. While they were stubs, such an extension built
 * cleanly and then rendered an empty view forever with nothing to explain
 * why — which is exactly how `wikipedia` behaved when it was first imported.
 */

const servers: Server[] = []
const dirs: string[] = []

/** A real HTTP server, so the fetch path is exercised rather than mocked. */
async function serve(handler: (url: string) => { status?: number; body: string; contentType?: string }): Promise<{
  url: string
  hits: () => number
}> {
  let hits = 0
  const server = createServer((request, response) => {
    hits += 1
    const result = handler(request.url ?? '/')
    response
      .writeHead(result.status ?? 200, { 'content-type': result.contentType ?? 'application/json' })
      .end(result.body)
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits: () => hits }
}

/**
 * Mounts a hook and returns a getter for its latest returned value.
 *
 * Awaits one tick before returning: `mount` schedules through the
 * reconciler's scheduler, so nothing has rendered yet when it comes back
 * and the getter would read `undefined` no matter what the hook does.
 */
async function renderHook<T>(useHook: () => T): Promise<() => T | undefined> {
  let latest: T | undefined
  function Probe() {
    latest = useHook()
    return null
  }
  mount(createElement(Probe), () => {})
  await flush()
  return () => latest
}

async function settle(times = 12) {
  for (let index = 0; index < times; index += 1) await flush()
}

beforeEach(() => {
  _resetNodeIdsForTests()
  // Keep every cached value inside the test's own directory rather than
  // the developer's real cache.
  const dir = mkdtempSync(join(tmpdir(), 'openray-hooks-'))
  dirs.push(dir)
  setCacheRootDirectory(dir)
})

afterEach(() => {
  for (const server of servers.splice(0)) server.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('useFetch', () => {
  it('loads JSON and exposes it as data', async () => {
    const host = await serve(() => ({ body: JSON.stringify({ title: 'Bootstrappable Builds' }) }))
    const result = await renderHook(() => useFetch<{ title: string }>(`${host.url}/story`))
    await settle()
    expect(result()?.data).toEqual({ title: 'Bootstrappable Builds' })
    expect(result()?.error).toBeUndefined()
    expect(result()?.isLoading).toBe(false)
  })

  it('reads a non-JSON response as text', async () => {
    const host = await serve(() => ({ body: 'plain words', contentType: 'text/plain' }))
    const result = await renderHook(() => useFetch<string>(`${host.url}/text`))
    await settle()
    expect(result()?.data).toBe('plain words')
  })

  it('surfaces an HTTP failure as an error rather than empty data', async () => {
    // The failure mode that matters: an extension that shows nothing gives
    // the user no way to tell "broken" from "still loading".
    const host = await serve(() => ({ status: 503, body: 'nope' }))
    const result = await renderHook(() => useFetch(`${host.url}/down`))
    await settle()
    expect(result()?.data).toBeUndefined()
    expect(result()?.error?.message).toMatch(/503/)
    expect(result()?.isLoading).toBe(false)
  })

  it('honors parseResponse and mapResult', async () => {
    const host = await serve(() => ({ body: JSON.stringify({ items: ['a', 'b'] }) }))
    const result = await renderHook(() =>
      useFetch<string[]>(`${host.url}/items`, {
        parseResponse: async (response) => (await response.json()) as unknown,
        mapResult: (parsed: never) => ({ data: (parsed as { items: string[] }).items }),
      }),
    )
    await settle()
    expect(result()?.data).toEqual(['a', 'b'])
  })

  it('does not request anything while execute is false', async () => {
    const host = await serve(() => ({ body: '{}' }))
    const result = await renderHook(() => useFetch(`${host.url}/gated`, { execute: false }))
    await settle()
    expect(host.hits()).toBe(0)
    expect(result()?.data).toBeUndefined()
  })
})

describe('useCachedPromise', () => {
  it('serves the previous result immediately on a later mount', async () => {
    // The launcher case this exists for: reopening a command should show
    // last time's results at once instead of flashing an empty list.
    //
    // Both mounts go through the *same* loader, as a remounted hook does —
    // the cache key includes the call site, so two differently-written
    // functions deliberately do not share an entry (see the test below).
    let pending: Promise<string> = Promise.resolve('value 1')
    const load = (_n: number) => pending

    const first = await renderHook(() => useCachedPromise(load, [1]))
    await settle()
    expect(first()?.data).toBe('value 1')

    // The refetch is deliberately slow, so "showed the cached value while
    // loading" is distinguishable from "showed the new value quickly".
    let release: (value: string) => void = () => {}
    pending = new Promise<string>((resolve) => {
      release = resolve
    })

    const second = await renderHook(() => useCachedPromise(load, [1]))

    // Cached value is on screen from the first render, before the refetch
    // has been kicked off at all.
    expect(second()?.data).toBe('value 1')

    // …and it stays there *while* the refetch is in flight, which is the
    // whole point: no empty flash between opening the command and the new
    // data arriving. (`usePromise` starts loading from an effect, so this
    // needs a tick to become observable.)
    await flush()
    expect(second()?.isLoading).toBe(true)
    expect(second()?.data).toBe('value 1')

    release('fresh 1')
    await settle()
    expect(second()?.data).toBe('fresh 1')
  })

  it('keeps different hooks apart even when their arguments are identical', async () => {
    // A page view routinely runs several of these with the same
    // `[title, language]` pair. Keying on arguments alone made them share
    // one entry, so a hook returning an array read back another's object
    // and crashed on `.filter` — what the real `wikipedia` extension did.
    const content = await renderHook(() => useCachedPromise(async (_id: string) => ['a', 'b'], ['same-args']))
    await settle()
    const metadata = await renderHook(() => useCachedPromise(async (_id: string) => ({ shape: 'object' }), ['same-args']))
    await settle()

    expect(content()?.data).toEqual(['a', 'b'])
    expect(metadata()?.data).toEqual({ shape: 'object' })

    // And the first hook still reads its own value back on a later mount,
    // rather than the second hook's.
    const contentAgain = await renderHook(() => useCachedPromise(async (_id: string) => ['a', 'b'], ['same-args']))
    expect(Array.isArray(contentAgain()?.data)).toBe(true)
  })

  it('falls back to initialData when nothing is cached yet', async () => {
    const result = await renderHook(() =>
      useCachedPromise(async () => 'loaded', [], { initialData: 'placeholder', execute: false }),
    )
    expect(result()?.data).toBe('placeholder')
  })
})
