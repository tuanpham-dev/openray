import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { COMMA, DOT, detectNumberFormat, formatGrouped, formatRaw, normalizeForParse } from '../src/format'

describe('format', () => {
  describe('detectNumberFormat', () => {
    let savedLcNumeric: string | undefined
    let savedLcAll: string | undefined
    let savedLang: string | undefined

    beforeEach(() => {
      savedLcNumeric = process.env.LC_NUMERIC
      savedLcAll = process.env.LC_ALL
      savedLang = process.env.LANG
      delete process.env.LC_NUMERIC
      delete process.env.LC_ALL
    })

    afterEach(() => {
      if (savedLcNumeric !== undefined) process.env.LC_NUMERIC = savedLcNumeric
      else delete process.env.LC_NUMERIC
      if (savedLcAll !== undefined) process.env.LC_ALL = savedLcAll
      else delete process.env.LC_ALL
      if (savedLang !== undefined) process.env.LANG = savedLang
      else delete process.env.LANG
    })

    it('detects comma-decimal from language prefix', () => {
      process.env.LANG = 'vi_VN.UTF-8'
      expect(detectNumberFormat()).toEqual(COMMA)
      process.env.LANG = 'en_US.UTF-8'
      expect(detectNumberFormat()).toEqual(DOT)
    })
  })

  it('groups large integers', () => {
    expect(formatGrouped(1234567, DOT)).toBe('1,234,567')
    expect(formatGrouped(1234567, COMMA)).toBe('1.234.567')
  })

  it('formats fractional values per locale', () => {
    expect(formatGrouped(1.5, DOT)).toBe('1.5')
    expect(formatGrouped(1.5, COMMA)).toBe('1,5')
  })

  it('small integers have no decimal point', () => {
    expect(formatGrouped(4.0, DOT)).toBe('4')
  })

  it('negative values keep the sign before the grouped digits', () => {
    expect(formatGrouped(-1234.5, DOT)).toBe('-1,234.5')
  })

  it('raw form is always dot-decimal and ungrouped', () => {
    expect(formatRaw(1234.5)).toBe('1234.5')
    expect(formatRaw(-4.0)).toBe('-4')
  })

  it('normalize strips groups and swaps decimal', () => {
    expect(normalizeForParse('1.234,5', COMMA)).toBe('1234.5')
    expect(normalizeForParse('1,234.5', DOT)).toBe('1234.5')
  })
})
