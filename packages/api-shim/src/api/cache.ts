import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getCommandContext, setCommandContext } from './command-context'

// Cache is deliberately local to this process (no Rust/RPC round trip) —
// that's the whole point versus LocalStorage, which goes through SQLite for
// durability. The root directory is the mounted command's own
// `supportPath` (identical to `assetsPath` — the extension's own install
// dir), read from the same per-async-context `commandContext` store T9
// made concurrency-safe (see command-context.ts's doc comment) — a
// separate `globalThis` slot here would reopen exactly the cross-mount
// staleness bug that store was built to close: a second command mounting
// would silently redirect the first command's *next* `new Cache()` call
// to the wrong extension's directory. Falls back to a per-process tmpdir
// so a stray `Cache()` at module scope (no command context established
// yet) doesn't crash import.
function cacheRoot(): string {
  const { supportPath } = getCommandContext()
  return supportPath || tmpdir()
}

/**
 * Convenience for setting just the cache root without a full
 * `CommandContext` — used by tests. Merges into whatever context is
 * already current (or the fallback) rather than replacing it, since
 * `commandContext`'s own store is now the single source of truth this
 * reads from.
 */
export function setCacheRootDirectory(dir: string): void {
  setCommandContext({ ...getCommandContext(), supportPath: dir })
}

export interface CacheOptions {
  capacity?: number
  namespace?: string
}

function readStore(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {}
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, string>
  } catch {
    return {}
  }
}

export class Cache {
  private readonly filePath: string
  private store: Record<string, string>
  private readonly capacity: number
  private readonly subscribers = new Set<(key: string, data: string | undefined) => void>()

  constructor(options?: CacheOptions) {
    const dir = join(cacheRoot(), '.openray-cache')
    mkdirSync(dir, { recursive: true })
    this.filePath = join(dir, `${options?.namespace ?? 'default'}.json`)
    this.capacity = options?.capacity ?? 10 * 1024 * 1024
    this.store = readStore(this.filePath)
  }

  private persist(): void {
    writeFileSync(this.filePath, JSON.stringify(this.store))
  }

  private notify(key: string, data: string | undefined): void {
    for (const subscriber of this.subscribers) subscriber(key, data)
  }

  get(key: string): string | undefined {
    return this.store[key]
  }

  has(key: string): boolean {
    return key in this.store
  }

  get isEmpty(): boolean {
    return Object.keys(this.store).length === 0
  }

  set(key: string, data: string): void {
    this.store[key] = data
    this.evictIfOverCapacity()
    this.persist()
    this.notify(key, data)
  }

  remove(key: string): boolean {
    if (!(key in this.store)) return false
    delete this.store[key]
    this.persist()
    this.notify(key, undefined)
    return true
  }

  clear(): void {
    const keys = Object.keys(this.store)
    this.store = {}
    this.persist()
    for (const key of keys) this.notify(key, undefined)
  }

  subscribe(callback: (key: string, data: string | undefined) => void): () => void {
    this.subscribers.add(callback)
    return () => this.subscribers.delete(callback)
  }

  private evictIfOverCapacity(): void {
    // Simplest possible eviction: drop oldest-inserted keys first once the
    // serialized size exceeds capacity. Real LRU tracking isn't worth the
    // complexity for what's meant to be a small, fast local cache.
    while (JSON.stringify(this.store).length > this.capacity) {
      const oldestKey = Object.keys(this.store)[0]
      if (oldestKey === undefined) break
      delete this.store[oldestKey]
    }
  }
}
