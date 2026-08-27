/** Unit conversion: `<value><unit> in|to <unit>`
 * (https://manual.raycast.com/calculator) — length, mass, temperature,
 * data size, area, volume, speed, plus three special target phrases (`px
 * at N ppi`, `to timespan`, `in workdays`). Ported from
 * `application/calculator/units.rs`. */

import { evalValue, type Calculation } from './expr'
import { formatGrouped, formatRaw, type NumberFormat } from './format'

type Category = 'length' | 'mass' | 'data' | 'area' | 'volume' | 'speed'

/** `[aliases, category, factor to the category's base unit]`. Base units:
 * meters, kilograms, bytes, square meters, liters, km/h. */
const UNITS: readonly [readonly string[], Category, number][] = [
  [['mm', 'millimeter', 'millimeters', 'millimetre', 'millimetres'], 'length', 0.001],
  [['cm', 'centimeter', 'centimeters', 'centimetre', 'centimetres'], 'length', 0.01],
  [['m', 'meter', 'meters', 'metre', 'metres'], 'length', 1.0],
  [['km', 'kilometer', 'kilometers', 'kilometre', 'kilometres'], 'length', 1000.0],
  [['in', 'inch', 'inches'], 'length', 0.0254],
  [['ft', 'feet', 'foot'], 'length', 0.3048],
  [['yd', 'yard', 'yards'], 'length', 0.9144],
  [['mi', 'mile', 'miles'], 'length', 1609.344],
  [['mg', 'milligram', 'milligrams'], 'mass', 1e-6],
  [['g', 'gram', 'grams'], 'mass', 0.001],
  [['kg', 'kilogram', 'kilograms'], 'mass', 1.0],
  [['t', 'ton', 'tons', 'tonne', 'tonnes'], 'mass', 1000.0],
  [['oz', 'ounce', 'ounces'], 'mass', 0.028_349_523_125],
  [['lb', 'lbs', 'pound', 'pounds'], 'mass', 0.453_592_37],
  [['st', 'stone', 'stones'], 'mass', 6.350_293_18],
  [['b', 'byte', 'bytes'], 'data', 1.0],
  [['kb', 'kilobyte', 'kilobytes'], 'data', 1e3],
  [['mb', 'megabyte', 'megabytes'], 'data', 1e6],
  [['gb', 'gigabyte', 'gigabytes'], 'data', 1e9],
  [['tb', 'terabyte', 'terabytes'], 'data', 1e12],
  [['pb', 'petabyte', 'petabytes'], 'data', 1e15],
  [['kib', 'kibibyte', 'kibibytes'], 'data', 1024.0],
  [['mib', 'mebibyte', 'mebibytes'], 'data', 1024.0 * 1024.0],
  [['gib', 'gibibyte', 'gibibytes'], 'data', 1024.0 * 1024.0 * 1024.0],
  [['tib', 'tebibyte', 'tebibytes'], 'data', 1024.0 * 1024.0 * 1024.0 * 1024.0],
  [['sqm'], 'area', 1.0],
  [['sqft'], 'area', 0.092_903_04],
  [['ml', 'milliliter', 'milliliters'], 'volume', 0.001],
  [['l', 'liter', 'liters', 'litre', 'litres'], 'volume', 1.0],
  [['gal', 'gallon', 'gallons'], 'volume', 3.785_411_784],
  [['kmh'], 'speed', 1.0],
  [['mph'], 'speed', 1.609_344],
]

/** Time units, used only by the `timespan`/`workdays` phrases — distinct
 * from `UNITS` since neither has a general-purpose "in seconds" use. */
const TIME_UNITS: readonly [readonly string[], number][] = [
  [['s', 'sec', 'secs', 'second', 'seconds'], 1.0],
  [['min', 'mins', 'minute', 'minutes'], 60.0],
  [['h', 'hr', 'hrs', 'hour', 'hours'], 3600.0],
]

function findUnit(word: string): { category: Category; factor: number } | undefined {
  const found = UNITS.find(([names]) => names.includes(word))
  return found ? { category: found[1], factor: found[2] } : undefined
}

function findTimeUnit(word: string): number | undefined {
  return TIME_UNITS.find(([names]) => names.includes(word))?.[1]
}

const TEMPERATURE_UNITS = new Set(['c', 'celsius', 'f', 'fahrenheit', 'k', 'kelvin'])

function toCelsius(value: number, unit: string): number | undefined {
  switch (unit) {
    case 'c':
    case 'celsius':
      return value
    case 'f':
    case 'fahrenheit':
      return ((value - 32.0) * 5.0) / 9.0
    case 'k':
    case 'kelvin':
      return value - 273.15
    default:
      return undefined
  }
}

function fromCelsius(celsius: number, unit: string): number | undefined {
  switch (unit) {
    case 'c':
    case 'celsius':
      return celsius
    case 'f':
    case 'fahrenheit':
      return (celsius * 9.0) / 5.0 + 32.0
    case 'k':
    case 'kelvin':
      return celsius + 273.15
    default:
      return undefined
  }
}

/** Splits `text` at the first `" in "` or `" to "` (case-insensitive),
 * whichever comes first — the connector Raycast's unit phrases use.
 * Exported since `currency.ts` (a sibling module) reuses it for its own
 * `<amount><currency> in|to <currency>` phrases — same connector,
 * different operand shape. */
export function splitOnConnector(text: string): [string, string] | undefined {
  const lower = text.toLowerCase()
  const inPos = lower.indexOf(' in ')
  const toPos = lower.indexOf(' to ')

  let pos: number
  if (inPos !== -1 && toPos !== -1) pos = Math.min(inPos, toPos)
  else if (inPos !== -1) pos = inPos
  else if (toPos !== -1) pos = toPos
  else return undefined

  return [text.slice(0, pos), text.slice(pos + 4)]
}

/** Splits `left` into a leading numeric expression and a trailing unit
 * word (`"10ft"` and `"10 ft"` both split as `("10", "ft")`). */
function splitValueAndUnit(left: string): [string, string] | undefined {
  const trimmed = left.trimEnd()
  let unitStart = -1
  for (let i = trimmed.length - 1; i >= 0; i--) {
    if (!/[a-zA-Z]/.test(trimmed[i] ?? '')) {
      unitStart = i + 1
      break
    }
  }
  if (unitStart === -1) return undefined
  if (unitStart === trimmed.length) return undefined
  return [trimmed.slice(0, unitStart), trimmed.slice(unitStart)]
}

function finish(expression: string, value: number, fmt: NumberFormat): Calculation {
  return { expression, result: formatGrouped(value, fmt), resultRaw: formatRaw(value) }
}

/** `<value><length unit> in|to px at <N> ppi` — pixels from any length
 * unit (not just inches: `5cm in px at 72 ppi` works the same way), via
 * inches since that's what ppi is defined against. */
function tryPixels(value: number, sourceUnit: string, target: string): number | undefined {
  if (!target.startsWith('px at')) return undefined
  const rest = target.slice('px at'.length).trim()
  const ppiText = (rest.endsWith('ppi') ? rest.slice(0, -'ppi'.length) : rest).trim()
  if (!/^\d+(\.\d+)?$/.test(ppiText)) return undefined
  const ppi = Number.parseFloat(ppiText)

  const unit = findUnit(sourceUnit)
  if (!unit || unit.category !== 'length') return undefined
  const meters = value * unit.factor
  const inches = meters / 0.0254
  return inches * ppi
}

/** `Xh Ym` (or just `Ym` under an hour), dropping any all-zero leading
 * component — Raycast's `145 mins to timespan` -> `2h 25m`. */
function formatTimespan(totalSeconds: number): string {
  const totalMinutes = Math.round(totalSeconds / 60)
  const hours = Math.trunc(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
}

/** `N workdays Mh` on an 8-hour workday — `55h in workdays` -> `6 workdays 7h`. */
function formatWorkdays(hours: number): string {
  const totalHours = Math.round(hours)
  const workdays = Math.trunc(totalHours / 8)
  const remaining = totalHours % 8
  return `${workdays} workdays ${remaining}h`
}

export function tryEval(query: string, fmt: NumberFormat): Calculation | undefined {
  const trimmed = query.trim()
  const split = splitOnConnector(trimmed)
  if (!split) return undefined
  const [left, right] = split
  const valueAndUnit = splitValueAndUnit(left)
  if (!valueAndUnit) return undefined
  const [valueText, sourceUnitRaw] = valueAndUnit
  const sourceUnit = sourceUnitRaw.toLowerCase()
  const target = right.trim()
  const targetLower = target.toLowerCase()

  const value = evalValue(valueText, fmt)
  if (value === undefined) return undefined

  const pixels = tryPixels(value, sourceUnit, targetLower)
  if (pixels !== undefined) return finish(trimmed, Math.round(pixels), fmt)

  if (targetLower === 'timespan') {
    const timeUnit = findTimeUnit(sourceUnit)
    if (timeUnit === undefined) return undefined
    const seconds = value * timeUnit
    return { expression: trimmed, result: formatTimespan(seconds), resultRaw: formatTimespan(seconds) }
  }
  if (targetLower === 'workdays') {
    const hoursFactor = findTimeUnit(sourceUnit)
    if (hoursFactor === undefined) return undefined
    if (hoursFactor !== 3600.0) return undefined // workdays only makes sense starting from hours
    return { expression: trimmed, result: formatWorkdays(value), resultRaw: formatWorkdays(value) }
  }

  if (TEMPERATURE_UNITS.has(sourceUnit)) {
    const celsius = toCelsius(value, sourceUnit)
    if (celsius === undefined) return undefined
    const result = fromCelsius(celsius, targetLower)
    if (result === undefined) return undefined
    return finish(trimmed, result, fmt)
  }

  const source = findUnit(sourceUnit)
  if (!source) return undefined
  const target2 = findUnit(targetLower)
  if (!target2) return undefined
  if (source.category !== target2.category) return undefined
  const result = (value * source.factor) / target2.factor
  return finish(trimmed, result, fmt)
}
