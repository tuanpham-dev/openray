/** Time and date queries (https://manual.raycast.com/calculator):
 * `time in 4 hours`, `days until 31 Mar`, `August 5 + 5`, `5pm ldn in sf`,
 * `diff paris`. Ported from `application/calculator/timedate.rs`.
 *
 * Every function here takes `now` as a parameter rather than reading the
 * clock itself, so tests are deterministic — `evaluate`'s (`index.ts`)
 * public wrapper passes `new Date()`.
 *
 * Timezone math uses Node's built-in `Intl` (ICU's bundled IANA tzdata)
 * rather than an external library — `chrono_tz`'s identifiers
 * (`"Europe/London"`) are exactly the IANA strings `Intl.DateTimeFormat`
 * expects natively. `zonedTimeToUtc` resolves a wall-clock time in a
 * given zone to a UTC instant via a single offset-lookup pass rather than
 * a full DST-transition-aware resolver — chrono_tz would handle an
 * ambiguous/skipped transition hour more rigorously, but every phrase
 * this module supports only ever asks for "today's" or "now's" time, so
 * that edge case is never actually reachable through it. */

import { splitOnConnector } from './units'
import type { Calculation } from './expr'
import type { NumberFormat } from './format'

const MONTHS: Record<string, number> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sep: 9,
  sept: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
}

const MONTH_ABBR = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** A curated set of major cities and common abbreviations — not
 * exhaustive; an unrecognised city just means this interpreter doesn't
 * match, and the query falls through like any other unrelated search
 * (~40 entries is the target size, not full IANA coverage). Keys are
 * lowercase with spaces stripped, matching how `normalizeCity` prepares
 * the query text. Values are IANA zone identifiers (see module doc
 * comment for why no `chrono_tz`-style enum is needed here). */
const CITY_ZONES: Record<string, string> = {
  london: 'Europe/London',
  ldn: 'Europe/London',
  paris: 'Europe/Paris',
  cet: 'Europe/Paris',
  berlin: 'Europe/Berlin',
  madrid: 'Europe/Madrid',
  rome: 'Europe/Rome',
  amsterdam: 'Europe/Amsterdam',
  moscow: 'Europe/Moscow',
  istanbul: 'Europe/Istanbul',
  dubai: 'Asia/Dubai',
  mumbai: 'Asia/Kolkata',
  delhi: 'Asia/Kolkata',
  india: 'Asia/Kolkata',
  singapore: 'Asia/Singapore',
  sg: 'Asia/Singapore',
  hongkong: 'Asia/Hong_Kong',
  hk: 'Asia/Hong_Kong',
  tokyo: 'Asia/Tokyo',
  jst: 'Asia/Tokyo',
  seoul: 'Asia/Seoul',
  beijing: 'Asia/Shanghai',
  shanghai: 'Asia/Shanghai',
  china: 'Asia/Shanghai',
  bangkok: 'Asia/Bangkok',
  ict: 'Asia/Bangkok',
  jakarta: 'Asia/Jakarta',
  taipei: 'Asia/Taipei',
  manila: 'Asia/Manila',
  kualalumpur: 'Asia/Kuala_Lumpur',
  hanoi: 'Asia/Ho_Chi_Minh',
  hcmc: 'Asia/Ho_Chi_Minh',
  sgn: 'Asia/Ho_Chi_Minh',
  saigon: 'Asia/Ho_Chi_Minh',
  vietnam: 'Asia/Ho_Chi_Minh',
  sydney: 'Australia/Sydney',
  melbourne: 'Australia/Melbourne',
  auckland: 'Pacific/Auckland',
  newyork: 'America/New_York',
  nyc: 'America/New_York',
  ny: 'America/New_York',
  est: 'America/New_York',
  sf: 'America/Los_Angeles',
  sanfrancisco: 'America/Los_Angeles',
  la: 'America/Los_Angeles',
  losangeles: 'America/Los_Angeles',
  pst: 'America/Los_Angeles',
  chicago: 'America/Chicago',
  cst: 'America/Chicago',
  denver: 'America/Denver',
  mst: 'America/Denver',
  toronto: 'America/Toronto',
  vancouver: 'America/Vancouver',
  mexicocity: 'America/Mexico_City',
  saopaulo: 'America/Sao_Paulo',
  brazil: 'America/Sao_Paulo',
  buenosaires: 'America/Argentina/Buenos_Aires',
  cairo: 'Africa/Cairo',
  johannesburg: 'Africa/Johannesburg',
  lagos: 'Africa/Lagos',
  utc: 'UTC',
  gmt: 'UTC',
}

function normalizeCity(text: string): string {
  return text.replace(/\s/g, '').toLowerCase()
}

function findZone(text: string): string | undefined {
  return CITY_ZONES[normalizeCity(text)]
}

/** The offset (minutes east of UTC) a wall clock in `timeZone` reads at
 * UTC instant `utcMs`. */
function tzOffsetMinutes(utcMs: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const map: Record<string, string> = {}
  for (const part of dtf.formatToParts(new Date(utcMs))) {
    if (part.type !== 'literal') map[part.type] = part.value
  }
  const asUtc = Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day), Number(map.hour), Number(map.minute), Number(map.second))
  return Math.round((asUtc - utcMs) / 60_000)
}

/** The Y-M-D `timeZone` reads at UTC instant `utcMs`. */
function zonedDateParts(utcMs: number, timeZone: string): { year: number; month: number; day: number } {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
  const map: Record<string, string> = {}
  for (const part of dtf.formatToParts(new Date(utcMs))) {
    if (part.type !== 'literal') map[part.type] = part.value
  }
  return { year: Number(map.year), month: Number(map.month), day: Number(map.day) }
}

/** Resolves a wall-clock time in `timeZone` to the UTC instant it
 * represents — see module doc comment for the single-pass approach's
 * scope. */
function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const guessMs = Date.UTC(year, month - 1, day, hour, minute, 0)
  const offset = tzOffsetMinutes(guessMs, timeZone)
  return new Date(guessMs - offset * 60_000)
}

function formatTimeInZone(utcMs: number, timeZone: string): string {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit', hourCycle: 'h12' })
  const map: Record<string, string> = {}
  for (const part of dtf.formatToParts(new Date(utcMs))) {
    if (part.type !== 'literal') map[part.type] = part.value
  }
  return `${map.hour}:${map.minute} ${(map.dayPeriod ?? '').toLowerCase()}`
}

function formatLocalTime(date: Date): string {
  let hour = date.getHours()
  const minute = date.getMinutes()
  const period = hour < 12 ? 'am' : 'pm'
  hour = hour % 12
  if (hour === 0) hour = 12
  return `${hour}:${String(minute).padStart(2, '0')} ${period}`
}

function sameResult(text: string): { result: string; resultRaw: string } {
  return { result: text, resultRaw: text }
}

/** `"5pm"`, `"5:30pm"`, `"17:00"` -> 24-hour `[hour, minute]`. */
function parseClockTime(text: string): [number, number] | undefined {
  const lower = text.replace(/\s/g, '').toLowerCase()

  let digits: string
  let meridiem: boolean | undefined
  if (lower.endsWith('am')) {
    digits = lower.slice(0, -2)
    meridiem = false
  } else if (lower.endsWith('pm')) {
    digits = lower.slice(0, -2)
    meridiem = true
  } else {
    digits = lower
    meridiem = undefined
  }

  const [hourText, minuteText] = digits.includes(':') ? digits.split(':', 2) : [digits, '0']
  if (hourText === undefined || minuteText === undefined) return undefined
  if (!/^\d+$/.test(hourText) || !/^\d+$/.test(minuteText)) return undefined
  let hour = Number.parseInt(hourText, 10)
  const minute = Number.parseInt(minuteText, 10)
  if (minute > 59) return undefined

  if (meridiem !== undefined) {
    if (hour < 1 || hour > 12) return undefined
    hour %= 12
    if (meridiem) hour += 12
  } else if (hour > 23) {
    return undefined
  }
  return [hour, minute]
}

/** `"31 Mar"`, `"March 31"`, `"2026-12-25"` -> a date. `"D Month"`/`"Month
 * D"` forms have no year in the text — `now`'s year is used (so the
 * caller decides whether that needs rolling forward, as `daysUntil`
 * does for "the next time this date occurs"). */
function parseDate(text: string, now: Date): { year: number; month: number; day: number } | undefined {
  const trimmed = text.trim()

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed)
  if (iso) {
    const year = Number(iso[1])
    const month = Number(iso[2])
    const day = Number(iso[3])
    if (month < 1 || month > 12 || day < 1 || day > 31) return undefined
    return { year, month, day }
  }

  const spaceIndex = trimmed.search(/\s/)
  if (spaceIndex === -1) return undefined
  const a = trimmed.slice(0, spaceIndex)
  const b = trimmed.slice(spaceIndex + 1).trim()
  const aLower = a.toLowerCase()
  const bLower = b.toLowerCase()

  const monthFromA = MONTHS[aLower]
  if (monthFromA !== undefined) {
    if (!/^\d+$/.test(b)) return undefined
    return { year: now.getFullYear(), month: monthFromA, day: Number(b) }
  }
  const monthFromB = MONTHS[bLower]
  if (monthFromB !== undefined) {
    if (!/^\d+$/.test(a)) return undefined
    return { year: now.getFullYear(), month: monthFromB, day: Number(a) }
  }
  return undefined
}

function toUtcMidnight(date: { year: number; month: number; day: number }): number {
  return Date.UTC(date.year, date.month - 1, date.day)
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

export function tryEval(query: string, _fmt: NumberFormat, now: Date): Calculation | undefined {
  const trimmed = query.trim()
  const lower = trimmed.toLowerCase()

  if (lower.startsWith('time in ')) {
    return timeIn(trimmed, trimmed.slice('time in '.length), now)
  }
  if (lower.startsWith('days until ')) {
    return daysUntil(trimmed, trimmed.slice('days until '.length), now)
  }
  if (lower.startsWith('diff ')) {
    return diff(trimmed, trimmed.slice('diff '.length), now)
  }
  const arithmetic = dateArithmetic(trimmed, now)
  if (arithmetic) return arithmetic
  return cityTime(trimmed, now)
}

function timeIn(expression: string, rest: string, now: Date): Calculation | undefined {
  const trimmedRest = rest.trim()
  const splitAt = /[a-zA-Z]/.exec(trimmedRest)?.index
  if (splitAt === undefined) return undefined
  const amountText = trimmedRest.slice(0, splitAt).trim()
  const unitText = trimmedRest.slice(splitAt).trim().toLowerCase()
  if (!/^-?\d+$/.test(amountText)) return undefined
  const amount = Number.parseInt(amountText, 10)

  let ms: number
  switch (unitText) {
    case 'minute':
    case 'minutes':
    case 'min':
    case 'mins':
      ms = amount * 60_000
      break
    case 'hour':
    case 'hours':
    case 'hr':
    case 'hrs':
      ms = amount * 3_600_000
      break
    case 'day':
    case 'days':
      ms = amount * 86_400_000
      break
    default:
      return undefined
  }

  const target = new Date(now.getTime() + ms)
  return { expression, ...sameResult(formatLocalTime(target)) }
}

function daysUntil(expression: string, dateText: string, now: Date): Calculation | undefined {
  const parsed = parseDate(dateText, now)
  if (!parsed) return undefined
  const todayUtc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
  let dateUtc = toUtcMidnight(parsed)
  if (dateUtc < todayUtc) {
    dateUtc = toUtcMidnight({ ...parsed, year: parsed.year + 1 })
  }
  const days = Math.round((dateUtc - todayUtc) / MS_PER_DAY)
  return { expression, ...sameResult(String(days)) }
}

/** `"August 5 + 5"` / `"August 5 - 5"` -> a date that many days later or
 * earlier. Only matches when the tail is exactly `<sign> <integer>` —
 * anything else (including a bare date with no arithmetic) isn't this
 * interpreter's job. */
function dateArithmetic(trimmed: string, now: Date): Calculation | undefined {
  const signPos = Math.max(trimmed.lastIndexOf('+'), trimmed.lastIndexOf('-'))
  if (signPos === -1) return undefined
  const dateText = trimmed.slice(0, signPos)
  const sign = trimmed[signPos]
  const nText = trimmed.slice(signPos + 1).trim()
  if (!/^\d+$/.test(nText)) return undefined
  const n = Number.parseInt(nText, 10)

  const base = parseDate(dateText, now)
  if (!base) return undefined
  const baseUtc = toUtcMidnight(base)
  const shiftedUtc = sign === '+' ? baseUtc + n * MS_PER_DAY : baseUtc - n * MS_PER_DAY
  const shiftedDate = new Date(shiftedUtc)
  const shifted = { year: shiftedDate.getUTCFullYear(), month: shiftedDate.getUTCMonth() + 1, day: shiftedDate.getUTCDate() }
  return { expression: trimmed, ...sameResult(`${shifted.day} ${MONTH_ABBR[shifted.month]} ${shifted.year}`) }
}

/** `"diff paris"` — the current hour offset between the local timezone
 * and `city`, signed from the local point of view (`+7h` means it's 7
 * hours later there). */
function diff(expression: string, cityText: string, now: Date): Calculation | undefined {
  const zone = findZone(cityText)
  if (!zone) return undefined
  const localOffset = -now.getTimezoneOffset()
  const remoteOffset = tzOffsetMinutes(now.getTime(), zone)
  const diffMinutes = remoteOffset - localOffset

  const sign = diffMinutes >= 0 ? '+' : '-'
  const magnitude = Math.abs(diffMinutes)
  const hours = Math.trunc(magnitude / 60)
  const minutes = magnitude % 60
  const text = minutes === 0 ? `${sign}${hours}h` : `${sign}${hours}h ${minutes}m`
  return { expression, ...sameResult(text) }
}

/** `"5pm ldn in sf"` — a clock time in one city, converted to another.
 * The calendar date is `now`'s (interpreted in the source city), which is
 * what makes this a snapshot conversion rather than a fully general
 * date+time+zone parser. */
function cityTime(trimmed: string, now: Date): Calculation | undefined {
  const split = splitOnConnector(trimmed)
  if (!split) return undefined
  const [left, right] = split
  const targetZone = findZone(right)
  if (!targetZone) return undefined

  const trimmedLeft = left.trim()
  let wordStart = -1
  for (let i = trimmedLeft.length - 1; i >= 0; i--) {
    if (/\s/.test(trimmedLeft[i] ?? '')) {
      wordStart = i + 1
      break
    }
  }
  if (wordStart === -1) return undefined
  const timeText = trimmedLeft.slice(0, wordStart)
  const cityText = trimmedLeft.slice(wordStart)
  const sourceZone = findZone(cityText)
  if (!sourceZone) return undefined
  const clock = parseClockTime(timeText)
  if (!clock) return undefined
  const [hour, minute] = clock

  const sourceDate = zonedDateParts(now.getTime(), sourceZone)
  const sourceUtcMs = zonedTimeToUtc(sourceDate.year, sourceDate.month, sourceDate.day, hour, minute, sourceZone).getTime()

  return { expression: trimmed, ...sameResult(formatTimeInZone(sourceUtcMs, targetZone)) }
}
