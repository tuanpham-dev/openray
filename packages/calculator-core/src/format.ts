/** Locale-aware number formatting shared by every calculator interpreter —
 * ported from `application/calculator/format.rs`.
 *
 * Raycast follows the system locale for which character is the decimal
 * point vs. the thousands separator (e.g. `1,5` is one-and-a-half in
 * German, `1.5` in English). The separator roles swap wholesale — never
 * guessed per-token — so both the tokenizer (parsing input) and the result
 * formatter (rendering output) take the same `NumberFormat`. */

/** Locales (by two-letter language prefix) that write numbers
 * comma-decimal, dot-group — the opposite of English. */
const COMMA_DECIMAL_LANGUAGES = new Set(['vi', 'de', 'fr', 'es', 'it', 'pt', 'nl', 'ru', 'id', 'pl', 'tr'])

export interface NumberFormat {
  decimal: string
  group: string
}

export const DOT: NumberFormat = { decimal: '.', group: ',' }
export const COMMA: NumberFormat = { decimal: ',', group: '.' }

/** Reads `LC_NUMERIC`, then `LC_ALL`, then `LANG` — the standard POSIX
 * locale-variable precedence, inherited unchanged into this Node process
 * from the same environment the native `std::env::var` calls read — and
 * picks comma-decimal when the language prefix matches
 * `COMMA_DECIMAL_LANGUAGES`. Falls back to dot-decimal otherwise. */
export function detectNumberFormat(): NumberFormat {
  const locale = process.env.LC_NUMERIC ?? process.env.LC_ALL ?? process.env.LANG ?? ''
  const language = locale.split(/[_.@]/)[0]?.toLowerCase() ?? ''
  return COMMA_DECIMAL_LANGUAGES.has(language) ? COMMA : DOT
}

/** Splits a non-negative value into its integer digits and, if it has a
 * fractional part worth showing, up to 10 significant decimal digits with
 * trailing zeros trimmed. */
function splitIntegerFraction(magnitude: number): { intPart: string; fracPart: string | null } {
  if (Number.isInteger(magnitude) && magnitude < 1e15) {
    return { intPart: magnitude.toFixed(0), fracPart: null }
  }

  const formatted = magnitude.toFixed(10)
  const dotIndex = formatted.indexOf('.')
  const intPart = dotIndex === -1 ? formatted : formatted.slice(0, dotIndex)
  const fracPart = dotIndex === -1 ? '' : formatted.slice(dotIndex + 1)
  const trimmed = fracPart.replace(/0+$/, '')
  return trimmed === '' ? { intPart, fracPart: null } : { intPart, fracPart: trimmed }
}

/** Inserts `separator` every three digits from the right, e.g.
 * `"1234567"` -> `"1,234,567"`. */
function groupDigits(digits: string, separator: string): string {
  let out = ''
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += separator
    out += digits[i]
  }
  return out
}

/** Renders `value` for display: thousands-grouped using `fmt`, integers
 * with no decimal part, otherwise trimmed to at most 10 significant
 * decimal digits with no trailing zeros. */
export function formatGrouped(value: number, fmt: NumberFormat): string {
  const negative = value < 0
  const magnitude = Math.abs(value)

  const { intPart, fracPart } = splitIntegerFraction(magnitude)
  const groupedInt = groupDigits(intPart, fmt.group)

  let out = negative ? '-' : ''
  out += groupedInt
  if (fracPart !== null) out += fmt.decimal + fracPart
  return out
}

/** Renders `value` in a fixed, locale-independent form — dot-decimal, no
 * grouping — for Raycast's "copy unformatted answer" and for anywhere else
 * a machine-parseable number is more useful than a display one. */
export function formatRaw(value: number): string {
  const negative = value < 0
  const { intPart, fracPart } = splitIntegerFraction(Math.abs(value))
  let out = negative ? '-' : ''
  out += intPart
  if (fracPart !== null) out += '.' + fracPart
  return out
}

/** Strips `fmt`'s group separator and normalizes `fmt`'s decimal separator
 * to `.`, so the result parses with `Number.parseFloat`. Used by the
 * tokenizer once it has scanned a full number's characters (digits,
 * decimal, and group separators, per `NumberFormat`). */
export function normalizeForParse(text: string, fmt: NumberFormat): string {
  let out = ''
  for (const c of text) {
    if (c === fmt.group) continue
    out += c === fmt.decimal ? '.' : c
  }
  return out
}
