import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Cache } from './api/cache'
import { LocalStorage, type LocalStorageValue } from './api/storage'

export interface UsePromiseOptions<T> {
  execute?: boolean
  onData?: (data: T) => void
  onError?: (error: Error) => void
  onWillExecute?: () => void
}

export interface MutateOptions<T> {
  optimisticUpdate?: (current: T | undefined) => T
  /** Defaults to true — restore the pre-update value if the work fails. */
  rollbackOnError?: boolean
  /** Defaults to true — re-run the loader once the work succeeds. */
  shouldRevalidateAfter?: boolean
}

/** The `mutate` a data hook hands back; `MutatePromise` in Raycast's own
 *  types, which extensions import to type a prop they pass it through. */
export type MutatePromise<T> = (asyncUpdate?: Promise<T>, options?: MutateOptions<T>) => Promise<void>

export interface UsePromiseResult<T> {
  data: T | undefined
  error: Error | undefined
  isLoading: boolean
  revalidate: () => void
  mutate: MutatePromise<T>
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
    async (asyncUpdate?: Promise<T>, mutateOptions?: MutateOptions<T>) => {
      // The point of an optimistic update is that it is *provisional*.
      // Without the rollback below, a failed write left the optimistic
      // value on screen — the list showing an item that was never created,
      // with no error anywhere.
      const previous = data
      if (mutateOptions?.optimisticUpdate) setData(mutateOptions.optimisticUpdate(data))
      if (!asyncUpdate) {
        run()
        return
      }
      try {
        const result = await asyncUpdate
        setData(result)
        // Raycast revalidates afterwards by default, so the optimistic
        // value is replaced by whatever the source of truth now says.
        if (mutateOptions?.shouldRevalidateAfter !== false) run()
      } catch (e) {
        if (mutateOptions?.rollbackOnError !== false) setData(previous)
        // Rethrown so the caller can report it — `showFailureToast` in a
        // `catch` is the idiom this pairs with.
        throw e instanceof Error ? e : new Error(String(e))
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

/** Raycast's shorthand validators. */
export const FormValidation = {
  /** Fails when the field is empty. */
  Required: 'required',
} as const

type ValidationError = string | undefined | null
type Validator = ((value: unknown) => ValidationError) | 'required'

export interface UseFormOptions<T extends Record<string, unknown>> {
  onSubmit: (values: T) => void | boolean | Promise<void | boolean>
  initialValues?: Partial<T>
  validation?: Partial<Record<keyof T, Validator>>
}

export interface UseFormResult<T extends Record<string, unknown>> {
  handleSubmit: (values: T) => void | boolean | Promise<void | boolean>
  /** Indexed by field id. The backing Proxy answers for *any* id, which a
   *  plain index signature can't express — hence the non-optional value. */
  itemProps: { [id: string]: Record<string, unknown> }
  setValidationError: (id: keyof T, error: ValidationError) => void
  setValue: <K extends keyof T>(id: K, value: T[K]) => void
  values: T
  focus: (id: keyof T) => void
  reset: (initialValues?: Partial<T>) => void
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  return false
}

/**
 * Raycast's form helper: validation, per-field props, and submit.
 *
 * 29 of 180 sampled extensions use it (and 21 use `FormValidation`). As a
 * stub, `const { handleSubmit, itemProps } = useForm(...)` destructured
 * without throwing — so the form *rendered*, looked completely normal, and
 * then did nothing at all on submit. A silent no-op is worse than a crash
 * here: nothing tells the user their click was ignored.
 *
 * Validation runs against the values the **renderer submits**, not against
 * mirrored state. The renderer already collects every field's effective
 * value (`collectValues` in `TreeRenderer`), so a second copy here could
 * drift from what the user actually sees.
 */
export function useForm<T extends Record<string, unknown>>({
  onSubmit,
  initialValues,
  validation,
}: UseFormOptions<T>): UseFormResult<T> {
  const [values, setValues] = useState<Partial<T>>(initialValues ?? {})
  const [errors, setErrors] = useState<Record<string, string | undefined>>({})
  // Bumped on every `focus()` call so asking for the same field twice
  // still re-fires — a boolean would only ever transition once.
  const [focusRequest, setFocusRequest] = useState<{ id: string; nonce: number } | null>(null)

  const validateField = useCallback(
    (id: string, value: unknown): string | undefined => {
      const rule = validation?.[id as keyof T]
      if (!rule) return undefined
      if (rule === 'required') return isEmpty(value) ? 'The item is required' : undefined
      const result = rule(value)
      return result ?? undefined
    },
    [validation],
  )

  const handleSubmit = useCallback(
    (submitted: T): void | boolean | Promise<void | boolean> => {
      const next: Record<string, string | undefined> = {}
      let firstInvalid: string | undefined
      for (const id of Object.keys(validation ?? {})) {
        const error = validateField(id, submitted?.[id as keyof T])
        if (error) {
          next[id] = error
          firstInvalid ??= id
        }
      }
      setErrors(next)
      if (firstInvalid) {
        // Raycast focuses the first field that failed; without it the
        // error can be scrolled out of sight in a long form.
        setFocusRequest((current) => ({ id: firstInvalid, nonce: (current?.nonce ?? 0) + 1 }))
        return false
      }
      return onSubmit(submitted)
    },
    [onSubmit, validateField, validation],
  )

  const setValue = useCallback(<K extends keyof T>(id: K, value: T[K]) => {
    setValues((current) => ({ ...current, [id]: value }))
  }, [])

  const setValidationError = useCallback((id: keyof T, error: ValidationError) => {
    setErrors((current) => ({ ...current, [id as string]: error ?? undefined }))
  }, [])

  const focus = useCallback((id: keyof T) => {
    setFocusRequest((current) => ({ id: id as string, nonce: (current?.nonce ?? 0) + 1 }))
  }, [])

  const reset = useCallback(
    (next?: Partial<T>) => {
      setValues(next ?? initialValues ?? {})
      setErrors({})
    },
    [initialValues],
  )

  /**
   * Props for any field the extension asks about.
   *
   * A Proxy rather than a prebuilt map: Raycast types `itemProps` over the
   * form's value type, so an extension may spread `itemProps.anything`,
   * and only the fields carrying validation are known here in advance.
   */
  const itemProps = useMemo(
    () =>
      new Proxy(
        {},
        {
          get(_target, prop) {
            if (typeof prop !== 'string') return undefined
            const props: Record<string, unknown> = { id: prop }
            if (errors[prop] !== undefined) props.error = errors[prop]
            if (values[prop as keyof T] !== undefined) props.defaultValue = values[prop as keyof T]
            if (focusRequest?.id === prop) props.focusRequest = focusRequest.nonce
            props.onChange = (value: unknown) => {
              setValues((current) => ({ ...current, [prop]: value }))
              // Raycast clears a field's error as soon as it changes, so
              // the message doesn't linger after the user fixes it.
              setErrors((current) => (current[prop] === undefined ? current : { ...current, [prop]: undefined }))
            }
            return props
          },
        },
      ) as Record<string, Record<string, unknown>>,
    [errors, values, focusRequest],
  )

  return {
    handleSubmit,
    itemProps,
    setValidationError,
    setValue,
    values: values as T,
    focus,
    reset,
  }
}
