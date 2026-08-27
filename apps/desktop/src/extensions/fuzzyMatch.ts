/**
 * Fuzzy subsequence match + relevance score for the host's own default
 * List/Grid filtering (`TreeRenderer.tsx`) — the fallback every extension
 * gets when it doesn't wire `onSearchTextChange` and do its own filtering.
 * Previously a plain case-insensitive `.includes()` check: it filtered
 * correctly but never scored or reordered results, so e.g. "sqcl" would
 * never match "Search Quicklinks" at all (not a substring), and among
 * matches that *did* contain the exact substring, a weak match earlier in
 * the list always outranked a strong match later in it — order was purely
 * insertion order, never relevance.
 *
 * Root search (`application::search::search`, Rust) already does this
 * properly via `nucleo_matcher` — this mirrors the same class of scoring
 * heuristic (consecutive runs, word-boundary starts, tighter span) for the
 * one place on the frontend that still didn't have it.
 *
 * Returns `null` when `needle` isn't a subsequence of `haystack` at all —
 * a non-match, not a low score. Case-insensitive throughout.
 */
export function fuzzyScore(haystack: string, needle: string): number | null {
  if (!needle) return 0
  if (!haystack) return null

  const h = haystack.toLowerCase()
  const n = needle.toLowerCase()

  let score = 0
  let searchFrom = 0
  let consecutiveRun = 0

  for (let i = 0; i < n.length; i++) {
    const foundAt = h.indexOf(n[i], searchFrom)
    if (foundAt === -1) return null

    const isConsecutive = foundAt === searchFrom
    consecutiveRun = isConsecutive ? consecutiveRun + 1 : 1
    // Quadratic, not linear: a long consecutive run must dominate over
    // the same character count scattered across several word-boundary
    // hits, or a query like "quick" would score a haystack with every
    // letter isolated between spaces ("q u i c k") as highly as one where
    // "quick" actually appears together — caught by this file's own test
    // (`scores a consecutive run higher than the same characters
    // scattered`), which failed under an earlier linear-growth version.
    score += consecutiveRun * consecutiveRun

    if (foundAt === 0) {
      score += 12 // matched at the very start of the haystack
    } else if (h[foundAt - 1] === ' ') {
      score += 6 // matched at a word boundary — real, but must stay well
      // under the consecutive-run bonus above so several small
      // word-boundary hits can't outweigh one long consecutive run.
    }

    searchFrom = foundAt + 1
  }

  // Between two matches of otherwise-equal quality, prefer the one whose
  // match span is tighter (needle characters closer together) and whose
  // haystack is shorter (less unrelated text surrounding the match) — the
  // same "less noise wins" bias `application::search`'s `TITLE_EXACT_BONUS`
  // documents on the Rust side, just continuous instead of a fixed bonus.
  const span = searchFrom - (h.indexOf(n[0]) >= 0 ? h.indexOf(n[0]) : 0)
  score -= span * 0.5
  score -= h.length * 0.05

  return score
}

/**
 * Filters `items` to fuzzy matches of `needle` against `text(item)`,
 * sorted by descending score (best match first) — replaces a bare
 * `.filter(...)` call that only ever preserved insertion order.
 */
export function fuzzyFilter<T>(items: readonly T[], needle: string, text: (item: T) => string): T[] {
  if (!needle) return [...items]
  const scored: { item: T; score: number }[] = []
  for (const item of items) {
    const score = fuzzyScore(text(item), needle)
    if (score !== null) scored.push({ item, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.map((s) => s.item)
}
