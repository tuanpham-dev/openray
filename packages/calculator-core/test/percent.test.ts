import { describe, expect, it } from 'vitest'
import { tryEval } from '../src/percent'
import { DOT } from '../src/format'

function resultOf(query: string): string | undefined {
  return tryEval(query, DOT)?.result
}

describe('percent', () => {
  it('percent of', () => {
    expect(resultOf('52% of 900')).toBe('468')
  })

  it('percent off', () => {
    expect(resultOf('20% off 80')).toBe('64')
  })

  it('percent tip on is the total including tip', () => {
    expect(resultOf('15% tip on 42')).toBe('48.3')
  })

  it('percent on', () => {
    expect(resultOf('10% on 200')).toBe('220')
  })

  it('operands may be expressions', () => {
    expect(resultOf('10% of (50 + 50)')).toBe('10')
  })

  it('a bare percent with no keyword is not handled here', () => {
    expect(tryEval('4400*12%', DOT)).toBeUndefined()
    expect(tryEval('52%', DOT)).toBeUndefined()
  })

  it('off is not mistaken for of', () => {
    // If "of" matched first (it's a prefix of "off"), this would evaluate
    // as "of f 80", which fails outright.
    expect(resultOf('20% off 80')).toBe('64')
  })
})
