import { describe, expect, it } from 'vitest'
import { RAYCAST_ICON_ALIASES, SYSTEM_ICON_NAMES, looksLikeIconName, lookupSystemIcon } from './systemIconNames'

describe('icon name handling', () => {
  it('treats a Raycast icon identifier as a name, not something to display', () => {
    // The bug this prevents: `hacker-news` renders `Icon.ArrowUpCircle`
    // beside every story, and the launcher printed "arrow-up-circle 5"
    // where the upvote count belonged.
    expect(looksLikeIconName('arrow-up-circle')).toBe(true)
    expect(looksLikeIconName('bubble')).toBe(true)
    expect(looksLikeIconName('magnifying-glass')).toBe(true)
  })

  it('treats a real glyph as content', () => {
    // Icon props accept an emoji as readily as a name, so the two have to
    // be told apart rather than unknown strings simply being dropped.
    expect(looksLikeIconName('🌐')).toBe(false)
    expect(looksLikeIconName('Hacker News')).toBe(false)
    expect(looksLikeIconName('A')).toBe(false)
  })

  it('recognises the stub marker an unimplemented API stringifies to', () => {
    expect(looksLikeIconName('[openray stub: getFavicon]')).toBe(true)
  })

  it('only aliases onto glyphs that actually exist', () => {
    // An alias pointing at a missing glyph would silently render nothing.
    for (const [name, target] of Object.entries(RAYCAST_ICON_ALIASES)) {
      expect(SYSTEM_ICON_NAMES[target], `${name} -> ${target}`).toBeDefined()
    }
  })
})

describe('lookupSystemIcon', () => {
  it('resolves a name this app ships a glyph for', () => {
    expect(lookupSystemIcon('trash')).toBeDefined()
  })

  it('resolves through an alias', () => {
    expect(lookupSystemIcon('magnifying-glass')).toBe(SYSTEM_ICON_NAMES.search)
  })

  it("tolerates Raycast's size suffix", () => {
    // The real `Icon` enum's values all carry one (`Trash = "trash-16"`).
    // Extensions using the enum get this shim's unsuffixed values, but the
    // prop takes any string, so a hardcoded one has to resolve too.
    expect(lookupSystemIcon('trash-16')).toBe(SYSTEM_ICON_NAMES.trash)
  })

  it("tolerates a variant number as well as the size", () => {
    // `Globe = "globe-01-16"` in the real enum; `globe` is an alias here.
    expect(lookupSystemIcon('globe-01-16')).toBe(SYSTEM_ICON_NAMES.link)
  })

  it('prefers an exact match over peeling a suffix', () => {
    // `volume-1` is a first-party name that genuinely ends in a number.
    expect(lookupSystemIcon('volume-1')).toBe(SYSTEM_ICON_NAMES['volume-1'])
    expect(lookupSystemIcon('volume-1')).not.toBe(SYSTEM_ICON_NAMES.volume)
  })

  it('gives up rather than guessing at a name it has nothing for', () => {
    expect(lookupSystemIcon('american-football-16')).toBeUndefined()
  })
})
