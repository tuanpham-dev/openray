import { describe, expect, it } from 'vitest'
import { tryEval } from '../src/units'
import { DOT } from '../src/format'

function resultOf(query: string): string | undefined {
  return tryEval(query, DOT)?.result
}

describe('units', () => {
  it('converts feet to meters', () => {
    const r = tryEval('10ft in m', DOT)
    expect(Math.abs(Number.parseFloat(r?.result ?? '0') - 3.048)).toBeLessThan(1e-9)
  })

  it('converts temperature', () => {
    const r = tryEval('100f in c', DOT)
    expect(Math.abs(Number.parseFloat(r?.result ?? '0') - 37.777_777_78)).toBeLessThan(1e-6)
  })

  it('converts across data scales', () => {
    const r = tryEval('1gb in mib', DOT)
    expect(Math.abs(Number.parseFloat((r?.result ?? '0').replace(/,/g, '')) - 953.674_316_406_25)).toBeLessThan(1e-6)
  })

  it('converts inches to pixels at a given ppi', () => {
    expect(resultOf('2 inches in px at 72 ppi')).toBe('144')
  })

  it('formats a duration as a timespan', () => {
    expect(resultOf('145 mins to timespan')).toBe('2h 25m')
  })

  it('formats hours as workdays', () => {
    expect(resultOf('55h in workdays')).toBe('6 workdays 7h')
  })

  it('rejects cross-category conversion', () => {
    expect(tryEval('10ft in kg', DOT)).toBeUndefined()
  })

  it('unrelated queries are not handled here', () => {
    expect(tryEval('2 + 2', DOT)).toBeUndefined()
    expect(tryEval('firefox', DOT)).toBeUndefined()
  })
})
