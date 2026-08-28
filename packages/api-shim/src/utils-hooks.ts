import { useCallback, useEffect, useRef, useState } from 'react'
import { Cache } from './api/cache'
import { LocalStorage, type LocalStorageValue } from './api/storage'

export interface UsePromiseOptions<T> {
  execute?: boolean
  onData?: (data: T) => void
  onError?: (error: Error) => void
  onWillExecute?: () => void
}

export interface UsePromiseResult<T> {
  data: T | undefined
  error: Error | undefined
  isLoading: boolean
  revalidate: () => void
  mutate: (asyncUpdate?: Promise<T>, options?: { optimisticUpdate?: (current: T | undefined) => T }) => Promise<void>
}

/**
 * A reasonably faithful (not exhaustive) port of @raycast/utils' usePromise:
 * tracks loading/data/error, re-runs when `args` changes by value, respects
 * `execute: false` gating, and exposes `revalidate`/`mutate`. No RPC
 * involved — this is pure React state, which is why it lives in T21
 * alongside the rest of the shim rather than needing a HostBridge call.
 */
export function usePromise<T, Args extends unknown[]>(
  fn: (...args: Args) => Promise<T>,
  args: Args = [] as unknown as Args,
  options?: UsePromiseOptions<T>,
): UsePromiseResult<T> {
  const [data, setData] = useState<T | undefined>(undefined)
  const [error, setError] = useState<Error | undefined>(undefined)
  const [isLoading, setIsLoading] = useState(false)
  const generation = useRef(0)
  const fnRef = useRef(fn)
  fnRef.current = fn
  const optionsRef = useRef(options)
  optionsRef.current = options

  const argsKey = JSON.stringify(args)

  const run = useCallback(() => {
    if (optionsRef.current?.execute === false) return
    const myGeneration = ++generation.current
    setIsLoading(true)
    optionsRef.current?.onWillExecute?.()
    fnRef
      .current(...args)
      .then((result) => {
        if (generation.current !== myGeneration) return
        setData(result)
        setError(undefined)
        optionsRef.current?.onData?.(result)
      })
      .catch((err: unknown) => {
        if (generation.current !== myGeneration) return
        const asError = err instanceof Error ? err : new Error(String(err))
        setError(asError)
        optionsRef.current?.onError?.(asError)
      })
      .finally(() => {
        if (generation.current === myGeneration) setIsLoading(false)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [argsKey, options?.execute])

  useEffect(() => {
    run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run])

  const mutate = useCallback(
    async (asyncUpdate?: Promise<T>, mutateOptions?: { optimisticUpdate?: (current: T | undefined) => T }) => {
      if (mutateOptions?.optimisticUpdate) setData(mutateOptions.optimisticUpdate(data))
      if (asyncUpdate) {
        const result = await asyncUpdate
        setData(result)
      } else {
        run()
      }
    },
    [data, run],
  )

  return { data, error, isLoading, revalidate: run, mutate }
}

const cachedStateCaches = new Map<string, Cache>()

function cacheFor(cacheNamespace?: string): Cache {
  const key = cacheNamespace ?? '__default'
  let cache = cachedStateCaches.get(key)
  if (!cache) {
    cache = new Cache({ namespace: `use-cached-state-${key}` })
    cachedStateCaches.set(key, cache)
  }
  return cache
}

export interface UseCachedStateOptions<T> {
  cacheNamespace?: string
  init?: () => T
}

/** Backed by Cache (T21), not LocalStorage — matches real @raycast/utils semantics (fast, local, not synced). */
export function useCachedState<T>(key: string, initialValue: T, options?: UseCachedStateOptions<T>): [T, (value: T | ((prev: T) => T)) => void] {
  const cache = cacheFor(options?.cacheNamespace)
  const [state, setState] = useState<T>(() => {
    const cached = cache.get(key)
    if (cached !== undefined) return JSON.parse(cached) as T
    return options?.init ? options.init() : initialValue
  })

  const setCachedState = useCallback(
    (value: T | ((prev: T) => T)) => {
      setState((prev) => {
        const next = typeof value === 'function' ? (value as (prev: T) => T)(prev) : value
        cache.set(key, JSON.stringify(next))
        return next
      })
    },
    [cache, key],
  )

  return [state, setCachedState]
}

/** djb2 — short, stable, and not security-relevant: this only has to tell
 *  two call sites apart. */
function hashString(value: string): string {
  let hash = 5381
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0
  }
  return (hash >>> 0).toString(36)
}

/** Its own namespace, not `useCachedState`'s — two hooks sharing one
 *  keyspace would let a state key and a promise key collide. */
let cachedPromiseStore: Cache | undefined
function cachedPromiseCache(): Cache {
  if (!cachedPromiseStore) cachedPromiseStore = new Cache({ namespace: 'use-cached-promise' })
  return cachedPromiseStore
}

export interface UseCachedPromiseOptions<T> extends UsePromiseOptions<T> {
  /** Shown before the first result arrives, and after a failure. */
  initialData?: T
  /** Keep the previous result on screen while the next one loads, instead
   *  of blanking the view — what makes a typeahead feel steady. */
  keepPreviousData?: boolean
}

/**
 * `useCachedPromise` — `usePromise` that remembers its last result across
 * mounts.
 *
 * The point in a launcher is the second open: a command that fetched
 * something a minute ago should show it immediately and refresh behind the
 * scenes, rather than flashing an empty list. Results are stored in the
 * same `Cache` the rest of the shim uses, keyed by the call's arguments, so
 * two different argument sets don't overwrite each other.
 *
 * Faithful in the ways extensions actually depend on (cached first paint,
 * `keepPreviousData`, `initialData`, `revalidate`/`mutate`); the upstream
 * hook's pagination support is not implemented.
 */
export function useCachedPromise<T, Args extends unknown[]>(
  fn: (...args: Args) => Promise<T>,
  args: Args = [] as unknown as Args,
  options?: UseCachedPromiseOptions<T>,
): UsePromiseResult<T> {
  const cache = cachedPromiseCache()
  /**
   * Keyed by *which* call this is as well as its arguments.
   *
   * Arguments alone are not unique: a page view will call several of these
   * hooks with the identical `[title, language]` pair, and keying on that
   * alone makes them share one entry and overwrite each other's results —
   * the content hook then reads back the metadata object and crashes on
   * `nodes.filter is not a function`. Exactly that happened with the real
   * `wikipedia` extension, whose detail view runs four such hooks.
   *
   * The function's *source text* identifies the call site: it differs
   * between hooks and is stable across renders, unlike the closure itself,
   * which is fresh every time and would miss the cache on every render.
   */
  const cacheKey = `${hashString(fn.toString())}:${JSON.stringify(args)}`

  const cached = useRef<T | undefined>(undefined)
  if (cached.current === undefined) {
    try {
      const stored = cache.get(cacheKey)
      if (stored !== undefined) cached.current = JSON.parse(stored) as T
    } catch {
      // A stale entry written by an older shape of this data is not worth
      // failing a render over; treat it as a miss.
      cached.current = undefined
    }
  }

  const result = usePromise(fn, args, {
    ...options,
    onData: (data) => {
      try {
        cache.set(cacheKey, JSON.stringify(data))
      } catch {
        // Unserializable results simply don't get cached.
      }
      options?.onData?.(data)
    },
  })

  const previous = useRef<T | undefined>(undefined)
  if (result.data !== undefined) previous.current = result.data

  const data =
    result.data ??
    (options?.keepPreviousData ? previous.current : undefined) ??
    cached.current ??
    options?.initialData

  return { ...result, data }
}

export interface UseFetchOptions<T> extends UseCachedPromiseOptions<T> {
  method?: string
  headers?: Record<string, string>
  body?: unknown
  /** Turns the `Response` into data. Defaults to JSON when the response
   *  says it is JSON, and text otherwise. */
  parseResponse?: (response: Response) => Promise<unknown>
  /** Reshapes what `parseResponse` returned. Upstream also allows
   *  `{ data, hasMore }` for pagination, which is not implemented. */
  mapResult?: (result: never) => { data: T }
}

async function defaultParseResponse(response: Response): Promise<unknown> {
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText}`)
  }
  const contentType = response.headers.get('content-type') ?? ''
  return contentType.includes('json') ? await response.json() : await response.text()
}

/**
 * `useFetch` — the hook most real Raycast extensions reach for, and the
 * single biggest gap between "builds against the shim" and "actually
 * works" (an extension using it renders an empty view forever, with
 * nothing to explain why).
 *
 * Implemented on `useCachedPromise` exactly as upstream describes it, so it
 * inherits the cached first paint and `keepPreviousData` behavior that
 * makes search-as-you-type usable.
 */
export function useFetch<T>(url: string, options?: UseFetchOptions<T>): UsePromiseResult<T> {
  const optionsRef = useRef(options)
  optionsRef.current = options

  // Re-runs when the URL or any request-shaping option changes — the same
  // by-value comparison `usePromise` does for its `args`.
  const requestKey = JSON.stringify([options?.method, options?.headers, options?.body])

  return useCachedPromise(
    async (target: string) => {
      const current = optionsRef.current
      const response = await fetch(target, {
        method: current?.method ?? 'GET',
        ...(current?.headers ? { headers: current.headers } : {}),
        ...(current?.body === undefined
          ? {}
          : { body: typeof current.body === 'string' ? current.body : JSON.stringify(current.body) }),
      })
      const parsed = await (current?.parseResponse ?? defaultParseResponse)(response)
      return (current?.mapResult ? current.mapResult(parsed as never).data : parsed) as T
    },
    [url, requestKey] as unknown as [string],
    options,
  )
}


/**
 * `LocalStorage` as React state — read once on mount, written through on
 * every change.
 *
 * Found stubbed by `devdocs`, which does
 * `JSON.parse(useLocalStorage("docs", …).value || "{}")`: the stub's
 * marker string is not JSON, so the parse threw during render and the
 * command never mounted at all. A stub is a fine placeholder for an API an
 * extension merely *mentions*; it is not one for a value the extension
 * immediately parses.
 *
 * `initialValue` is what `value` reads as until the stored value arrives
 * (and after `removeValue`), matching the real hook — which is why
 * `isLoading` exists to tell "not read yet" from "genuinely unset".
 */
export function useLocalStorage<T extends LocalStorageValue>(
  key: string,
  initialValue?: T,
): {
  value: T | undefined
  setValue: (value: T) => Promise<void>
  removeValue: () => Promise<void>
  isLoading: boolean
} {
  const [value, setStateValue] = useState<T | undefined>(initialValue)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setIsLoading(true)
    void LocalStorage.getItem<T>(key)
      .then((stored) => {
        if (cancelled) return
        setStateValue((stored as T | undefined) ?? initialValue)
      })
      .catch(() => {
        // A storage failure should leave the caller with its own default
        // rather than an exception it has no way to handle mid-render.
        if (!cancelled) setStateValue(initialValue)
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })
    return () => {
      cancelled = true
    }
    // `initialValue` is deliberately not a dependency: extensions pass a
    // fresh object/string literal on every render, which would re-read
    // storage forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const setValue = useCallback(
    async (next: T) => {
      setStateValue(next)
      await LocalStorage.setItem(key, next)
    },
    [key],
  )

  const removeValue = useCallback(async () => {
    setStateValue(initialValue)
    await LocalStorage.removeItem(key)
    // Same reasoning as above — the identity of `initialValue` must not
    // churn this callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return { value, setValue, removeValue, isLoading }
}
