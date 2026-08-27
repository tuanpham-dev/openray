import { useCallback, useEffect, useRef, useState } from 'react'
import { Cache } from './api/cache'

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
