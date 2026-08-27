import { describe, expect, it } from 'vitest'
import { LANGUAGES, matchLanguage } from '../src/languages'

describe('matchLanguage', () => {
  it('matches a name prefix', () => {
    expect(matchLanguage('jap')?.code).toBe('ja')
    expect(matchLanguage('german')?.code).toBe('de')
  })

  it('matches an exact code case-insensitively', () => {
    expect(matchLanguage('FR')?.code).toBe('fr')
    expect(matchLanguage('zh-cn')?.code).toBe('zh-CN')
  })

  it('returns undefined for no match', () => {
    expect(matchLanguage('xyzzy')).toBeUndefined()
    expect(matchLanguage('')).toBeUndefined()
    expect(matchLanguage('   ')).toBeUndefined()
  })

  it('codes and names are unique', () => {
    const codes = new Set<string>()
    const names = new Set<string>()
    for (const lang of LANGUAGES) {
      expect(codes.has(lang.code), `duplicate code ${lang.code}`).toBe(false)
      codes.add(lang.code)
      expect(names.has(lang.name), `duplicate name ${lang.name}`).toBe(false)
      names.add(lang.name)
    }
  })
})
