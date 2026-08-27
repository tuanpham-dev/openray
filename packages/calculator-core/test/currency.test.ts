import { describe, expect, it } from 'vitest'
import { tryEval, type RateTable } from '../src/currency'
import { DOT } from '../src/format'

function testTable(): RateTable {
  return {
    base: 'USD',
    rates: { USD: 1.0, EUR: 0.9, GBP: 0.8, VND: 25000.0 },
    fetchedAt: Date.now(),
  }
}

function parseResult(rendered: string): [number, string] {
  const lastSpace = rendered.lastIndexOf(' ')
  const number = rendered.slice(0, lastSpace)
  const code = rendered.slice(lastSpace + 1)
  return [Number.parseFloat(number.replace(/,/g, '')), code]
}

describe('currency', () => {
  it('converts using the cached table', () => {
    const r = tryEval('100 usd in gbp', DOT, testTable())
    const [number, code] = parseResult(r?.result ?? '')
    expect(code).toBe('GBP')
    expect(Math.abs(number - 80.0)).toBeLessThan(1e-6)
  })

  it('prefix-glued code with shorthand amount', () => {
    const r = tryEval('USD1K in eur', DOT, testTable())
    const [number, code] = parseResult(r?.result ?? '')
    expect(code).toBe('EUR')
    expect(Math.abs(number - 900.0)).toBeLessThan(1e-6)
  })

  it('shorthand amount with trailing code', () => {
    const r = tryEval('1.5k eur to vnd', DOT, testTable())
    const [number, code] = parseResult(r?.result ?? '')
    expect(code).toBe('VND')
    // 1500 EUR / 0.9 (EUR per USD) * 25000 (VND per USD).
    expect(Math.abs(number - 41_666_666.666_666_67)).toBeLessThan(1e-2)
  })

  it('symbol prefix is accepted', () => {
    const r = tryEval('$100 in eur', DOT, testTable())
    const [number, code] = parseResult(r?.result ?? '')
    expect(code).toBe('EUR')
    expect(Math.abs(number - 90.0)).toBeLessThan(1e-6)
  })

  it('unknown currency code does not match', () => {
    expect(tryEval('100 usd in xyz', DOT, testTable())).toBeUndefined()
  })

  it('returns undefined with no cache loaded', () => {
    expect(tryEval('100 usd in gbp', DOT, undefined)).toBeUndefined()
  })
})
