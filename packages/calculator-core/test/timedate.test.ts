import { describe, expect, it } from 'vitest'
import { tryEval } from '../src/timedate'
import { DOT } from '../src/format'

/** A fixed instant — mid-July, so both London and Los Angeles are in
 * their respective DST periods, keeping the offset between them a
 * predictable 8 hours for `converts_a_time_between_cities`. */
function pinnedNow(): Date {
  return new Date(2026, 6, 15, 12, 0, 0)
}

describe('timedate', () => {
  it('future time after a duration', () => {
    const now = new Date(2026, 7, 17, 10, 0, 0)
    const r = tryEval('time in 4 hours', DOT, now)
    expect(r?.result).toBe('2:00 pm')
  })

  it('days until a future date this year', () => {
    const now = new Date(2026, 7, 17, 10, 0, 0)
    const r = tryEval('days until 25 dec', DOT, now)
    expect(r?.result).toBe('130')
  })

  it('days until rolls forward when the date already passed this year', () => {
    const now = new Date(2026, 7, 17, 10, 0, 0)
    const r = tryEval('days until 31 mar', DOT, now)
    // 31 Mar 2026 is behind `now`; the next occurrence is 2027.
    const todayUtc = Date.UTC(2026, 7, 17)
    const expectedUtc = Date.UTC(2027, 2, 31)
    const expectedDays = Math.round((expectedUtc - todayUtc) / 86_400_000)
    expect(r?.result).toBe(String(expectedDays))
  })

  it('date plus days', () => {
    const now = new Date(2026, 7, 17, 10, 0, 0)
    const r = tryEval('August 5 + 5', DOT, now)
    expect(r?.result).toBe('10 Aug 2026')
  })

  it('date minus days', () => {
    const now = new Date(2026, 7, 17, 10, 0, 0)
    const r = tryEval('August 5 - 5', DOT, now)
    expect(r?.result).toBe('31 Jul 2026')
  })

  it('converts a time between cities', () => {
    const r = tryEval('5pm ldn in sf', DOT, pinnedNow())
    expect(r?.result).toBe('9:00 am')
  })

  it('diff reports a signed hour offset', () => {
    const r = tryEval('diff paris', DOT, pinnedNow())
    expect(r?.result.startsWith('+') || r?.result.startsWith('-')).toBe(true)
    expect(r?.result.includes('h')).toBe(true)
  })

  it('unrecognised city does not match', () => {
    expect(tryEval('diff atlantis', DOT, pinnedNow())).toBeUndefined()
  })

  it('unrelated queries are not handled here', () => {
    expect(tryEval('2 + 2', DOT, pinnedNow())).toBeUndefined()
    expect(tryEval('firefox', DOT, pinnedNow())).toBeUndefined()
  })
})
