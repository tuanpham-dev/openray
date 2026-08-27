import { describe, expect, it } from 'vitest'
import { tryEval } from '../src/expr'
import { DOT, COMMA } from '../src/format'

function resultOf(query: string): string | undefined {
  return tryEval(query, DOT)?.result
}

describe('expr', () => {
  it('evaluates percentage of a number', () => {
    expect(resultOf('4400*12%')).toBe('528')
  })

  it('evaluates basic arithmetic', () => {
    expect(resultOf('2 + 2')).toBe('4')
  })

  it('respects operator precedence and parens', () => {
    expect(resultOf('(2 + 3) * 4')).toBe('20')
    expect(resultOf('2 + 3 * 4')).toBe('14')
  })

  it('evaluates factorial', () => {
    expect(resultOf('5!')).toBe('120')
  })

  it('evaluates power', () => {
    expect(resultOf('2^10')).toBe('1,024')
  })

  it('formats fractional results without trailing zeros', () => {
    expect(resultOf('1/4')).toBe('0.25')
  })

  it('echoes back the expression that was evaluated', () => {
    const calculation = tryEval('2 + 2', DOT)
    expect(calculation?.expression).toBe('2 + 2')
    expect(calculation?.result).toBe('4')
    expect(calculation?.resultRaw).toBe('4')
  })

  it('completes a missing closing paren', () => {
    const calculation = tryEval('(2 + 3) * (4 + 1', DOT)
    expect(calculation?.expression).toBe('(2 + 3) * (4 + 1)')
    expect(calculation?.result).toBe('25')
  })

  it('completes a missing opening paren', () => {
    const calculation = tryEval('2 + 3) * 4', DOT)
    expect(calculation?.expression).toBe('(2 + 3) * 4')
    expect(calculation?.result).toBe('20')
  })

  it('does not treat app names as math', () => {
    expect(tryEval('firefox', DOT)).toBeUndefined()
  })

  it('unbalanced parens alone are still not math', () => {
    expect(tryEval('(', DOT)).toBeUndefined()
    expect(tryEval('()', DOT)).toBeUndefined()
  })

  it('rejects division by zero', () => {
    expect(tryEval('1/0', DOT)).toBeUndefined()
  })

  it('rejects malformed expressions', () => {
    expect(tryEval('2 +', DOT)).toBeUndefined()
    expect(tryEval('2 ** 3', DOT)).toBeUndefined()
  })

  it('evaluates square root with and without parens', () => {
    expect(resultOf('sqrt 16')).toBe('4')
    expect(resultOf('sqrt(16)')).toBe('4')
    expect(tryEval('sqrt(-1)', DOT)).toBeUndefined()
  })

  it('function without parens binds tighter than addition', () => {
    // sqrt(16) + 4, not sqrt(16 + 4).
    expect(resultOf('sqrt 16 + 4')).toBe('8')
  })

  it('evaluates trig and degrees postfix', () => {
    expect(resultOf('sin(pi/2)')).toBe('1')
    const ninetyDegrees = tryEval('sin(90 deg)', DOT)
    expect(Math.abs(Number.parseFloat(ninetyDegrees?.result ?? '0') - 1.0)).toBeLessThan(1e-9)
  })

  it('evaluates word power operator', () => {
    expect(resultOf('2 power 10')).toBe('1,024')
  })

  it('evaluates other word operators', () => {
    expect(resultOf('6 plus 4')).toBe('10')
    expect(resultOf('10 minus 4')).toBe('6')
    expect(resultOf('6 times 4')).toBe('24')
    expect(resultOf('6 x 4')).toBe('24')
    expect(resultOf('10 divided by 4')).toBe('2.5')
    expect(resultOf('10 mod 3')).toBe('1')
  })

  it('evaluates constants', () => {
    expect(resultOf('pi')).toBe('3.1415926536')
  })

  it('applies number shorthand suffixes', () => {
    expect(resultOf('10K + 5')).toBe('10,005')
    expect(resultOf('2.5M')).toBe('2,500,000')
    expect(resultOf('1B')).toBe('1,000,000,000')
  })

  it('accepts grouped input per locale', () => {
    expect(resultOf('1,000 / 4')).toBe('250')
    const commaLocale = tryEval('1.000 / 4', COMMA)
    expect(commaLocale?.result).toBe('250')
  })

  it('unrecognised word fails the whole expression', () => {
    expect(tryEval('2 + banana', DOT)).toBeUndefined()
  })

  it('rejects a malformed multi-decimal number chunk', () => {
    // Rust's strict str::parse::<f64>() fails on "1.2.3" — JS's lenient
    // parseFloat would otherwise silently accept "1.2" and drop the rest.
    expect(tryEval('1.2.3 + 1', DOT)).toBeUndefined()
  })
})
