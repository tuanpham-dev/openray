import { useCallback, useEffect, useMemo, useState } from 'react'
import { LocalStorage } from './storage'

interface Visit {
  hits: number
  lastUsedAt: number
}

type VisitMap = Record<string, Visit>

const STORAGE_KEY = 'openray.frecency'

/**
 * Frequency-and-recency ranking for an extension's own items.
 *
 * Stored in the calling extension's `LocalStorage` namespace rather than
 * the app's own frecency table. That is deliberate and stronger than
 * sharing one store would be: an extension's ranking of *its* items can
 * never perturb root search, and no cross-extension key collisions are
 * possible. It also means no schema migration and no bridge method.
 */
function score(visit: Visit, now: number): number {
  // Halve the weight of a visit every 7 days, so something used twice
  // today outranks something used ten times last month — which is the
  // whole point of frecency over a plain hit count.
  const ageDays = Math.max(0, (now - visit.lastUsedAt) / 86_400_000)
  return visit.hits * Math.pow(0.5, ageDays / 7)
}

export interface UseFrecencySortingOptions<T> {
  /** How to identify an item across runs; defaults to `item.id`. */
  key?: (item: T) => string
  /** Items to keep at the top regardless of ranking. */
  sortUnvisited?: (a: T, b: T) => number
}

/**
 * Sorts items by how often and how recently they were used.
 *
 * Returns Raycast's own triple: the sorted list, a function to record a
 * use, and one to forget an item. 7 of 180 sampled extensions use it, and
 * as a stub the list simply never reordered.
 */
export function useFrecencySorting<T>(
  items: T[] = [],
  options?: UseFrecencySortingOptions<T>,
): [T[], (item: T) => Promise<void>, (item: T) => Promise<void>] {
  const [visits, setVisits] = useState<VisitMap>({})

  const keyOf = useCallback(
    (item: T): string => {
      if (options?.key) return options.key(item)
      const candidate = (item as { id?: unknown })?.id
      return typeof candidate === 'string' ? candidate : JSON.stringify(item)
    },
    [options],
  )

  useEffect(() => {
    let cancelled = false
    void LocalStorage.getItem<string>(STORAGE_KEY)
      .then((raw) => {
        if (cancelled || !raw) return
        try {
          setVisits(JSON.parse(raw) as VisitMap)
        } catch {
          // A corrupt store should cost the ranking, not the command.
          setVisits({})
        }
      })
      .catch(() => {
        if (!cancelled) setVisits({})
      })
    return () => {
      cancelled = true
    }
  }, [])

  const persist = useCallback(async (next: VisitMap) => {
    setVisits(next)
    await LocalStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }, [])

  const visitItem = useCallback(
    async (item: T) => {
      const key = keyOf(item)
      const existing = visits[key]
      await persist({
        ...visits,
        [key]: { hits: (existing?.hits ?? 0) + 1, lastUsedAt: Date.now() },
      })
    },
    [keyOf, persist, visits],
  )

  const resetRanking = useCallback(
    async (item: T) => {
      const next = { ...visits }
      delete next[keyOf(item)]
      await persist(next)
    },
    [keyOf, persist, visits],
  )

  const sorted = useMemo(() => {
    const now = Date.now()
    // Visited items first, ranked; unvisited keep their original order
    // unless the caller supplied a comparator, matching Raycast — an
    // alphabetical list shouldn't scramble just because nothing is ranked.
    const visited: { item: T; score: number }[] = []
    const unvisited: T[] = []
    for (const item of items) {
      const visit = visits[keyOf(item)]
      if (visit) visited.push({ item, score: score(visit, now) })
      else unvisited.push(item)
    }
    visited.sort((a, b) => b.score - a.score)
    if (options?.sortUnvisited) unvisited.sort(options.sortUnvisited)
    return [...visited.map((v) => v.item), ...unvisited]
  }, [items, visits, keyOf, options])

  return [sorted, visitItem, resetRanking]
}
