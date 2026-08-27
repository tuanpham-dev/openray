import { describe, expect, it } from 'vitest'
import { fuzzyFilter, fuzzyScore } from './fuzzyMatch'

describe('fuzzyScore', () => {
  it('returns null when the needle is not a subsequence of the haystack', () => {
    expect(fuzzyScore('Firefox', 'xyz')).toBeNull()
  })

  it('matches a subsequence that is not a contiguous substring', () => {
    // "sqcl" never appears literally in "Search Quicklinks", but every
    // character does, in order — this is the exact case a plain
    // `.includes()` check can never find.
    expect(fuzzyScore('Search Quicklinks', 'sqcl')).not.toBeNull()
  })

  it('is case-insensitive', () => {
    expect(fuzzyScore('Firefox', 'FIREFOX')).toEqual(fuzzyScore('Firefox', 'firefox'))
  })

  it('an empty needle matches everything with a score of 0', () => {
    expect(fuzzyScore('anything', '')).toBe(0)
  })

  it('scores a match at the very start higher than the same needle found mid-string', () => {
    const atStart = fuzzyScore('Center Window', 'center')
    const midString = fuzzyScore('Top Center Sixth', 'center')
    expect(atStart).not.toBeNull()
    expect(midString).not.toBeNull()
    expect(atStart! > midString!).toBe(true)
  })

  it('scores a word-boundary match higher than a match embedded inside a word', () => {
    // "win" starts a word in "Switch Window" (after the space) and is
    // embedded inside "Switch" in "Switch to Window" is not a fair
    // comparison — use two haystacks where only the boundary differs.
    const boundary = fuzzyScore('App Window', 'win')
    const embedded = fuzzyScore('Appwindow', 'win')
    expect(boundary).not.toBeNull()
    expect(embedded).not.toBeNull()
    expect(boundary! > embedded!).toBe(true)
  })

  it('scores a consecutive run higher than the same characters scattered', () => {
    const consecutive = fuzzyScore('quick fix', 'quick')
    const scattered = fuzzyScore('q u i c k', 'quick')
    expect(consecutive).not.toBeNull()
    expect(scattered).not.toBeNull()
    expect(consecutive! > scattered!).toBe(true)
  })

  it('prefers a tighter match span between two otherwise-equal matches', () => {
    const tight = fuzzyScore('abXcXd', 'abcd')
    const loose = fuzzyScore('aXXbXXcXXd', 'abcd')
    expect(tight).not.toBeNull()
    expect(loose).not.toBeNull()
    expect(tight! > loose!).toBe(true)
  })

  it('reproduces the exact live scenario: "center" must rank Center above Top Center Sixth', () => {
    // Mirrors application::search's own regression test for the same bug
    // on the Rust side (search.rs's exact_title_match_ranks_above_a_longer_
    // title_containing_it) — the frontend's default List/Grid filtering
    // needs the identical fix, independently, since it's a separate code
    // path with its own previously-unscored `.includes()` filter.
    const center = fuzzyScore('Center', 'center')!
    const topCenterSixth = fuzzyScore('Top Center Sixth', 'center')!
    expect(center).toBeGreaterThan(topCenterSixth)
  })
})

describe('fuzzyFilter', () => {
  it('filters out non-matches and keeps matches', () => {
    const items = ['Firefox', 'Calculator', 'Files']
    expect(fuzzyFilter(items, 'fire', (s) => s)).toEqual(['Firefox'])
  })

  it('sorts matches by descending score instead of preserving insertion order', () => {
    // "Top Center Sixth" is registered before "Center" — a plain
    // `.filter()` would leave it first; a real fuzzy score must not.
    const items = ['Top Center Sixth', 'Center']
    expect(fuzzyFilter(items, 'center', (s) => s)).toEqual(['Center', 'Top Center Sixth'])
  })

  it('an empty needle returns every item, unsorted (no filtering, no reordering)', () => {
    const items = ['b', 'a', 'c']
    expect(fuzzyFilter(items, '', (s) => s)).toEqual(['b', 'a', 'c'])
  })

  it('returns an empty array when nothing matches', () => {
    expect(fuzzyFilter(['Firefox', 'Calculator'], 'xyz', (s) => s)).toEqual([])
  })
})
