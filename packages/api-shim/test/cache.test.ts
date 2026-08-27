import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, afterEach, beforeEach } from 'vitest'
import { Cache, setCacheRootDirectory } from '../src/api/cache'

let workDir: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'api-shim-cache-'))
  setCacheRootDirectory(workDir)
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('Cache', () => {
  it('persists get/set/has/remove/clear across instances sharing a namespace', () => {
    const a = new Cache({ namespace: 'shared' })
    expect(a.isEmpty).toBe(true)
    a.set('greeting', 'hello')
    expect(a.get('greeting')).toBe('hello')
    expect(a.has('greeting')).toBe(true)

    const b = new Cache({ namespace: 'shared' })
    expect(b.get('greeting')).toBe('hello')

    expect(b.remove('greeting')).toBe(true)
    expect(b.remove('greeting')).toBe(false)
    expect(a.get('greeting')).toBe('hello') // a's in-memory copy is stale until reconstructed — expected, matches file-backed semantics

    const c = new Cache({ namespace: 'shared' })
    expect(c.isEmpty).toBe(true)
  })

  it('keeps separate namespaces isolated', () => {
    const ns1 = new Cache({ namespace: 'one' })
    const ns2 = new Cache({ namespace: 'two' })
    ns1.set('key', 'from-one')
    expect(ns2.get('key')).toBeUndefined()
  })

  it('notifies subscribers on set/remove/clear', () => {
    const cache = new Cache({ namespace: 'subs' })
    const events: Array<[string, string | undefined]> = []
    const unsubscribe = cache.subscribe((key, data) => events.push([key, data]))

    cache.set('a', '1')
    cache.remove('a')
    cache.set('b', '2')
    cache.clear()

    expect(events).toEqual([
      ['a', '1'],
      ['a', undefined],
      ['b', '2'],
      ['b', undefined],
    ])

    unsubscribe()
    cache.set('c', '3')
    expect(events).toHaveLength(4) // unchanged after unsubscribe
  })
})
