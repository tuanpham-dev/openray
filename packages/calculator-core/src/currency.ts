/** Currency conversion: `<amount> <CUR> in|to <CUR>`
 * (https://manual.raycast.com/calculator), e.g. `100 usd in gbp`,
 * `USD1K in eur`, `1.5k eur to vnd`. Ported from
 * `application/calculator/currency.rs` — but only the pure conversion
 * math: this module never fetches or caches rates itself (unlike the
 * Rust original, which owned a process-wide cache populated by a
 * background thread). The extension's own `rates.ts` does that instead,
 * via `LocalStorage`, and passes the current `RateTable` in — see its
 * module doc comment for why `spawn_root_provider_startup` (T14) is the
 * natural "once, at startup" trigger point here, matching
 * `spawn_rate_refresh`'s original contract with zero new host
 * infrastructure. */

import { evalValue, type Calculation } from './expr'
import { formatGrouped, formatRaw, type NumberFormat } from './format'
import { splitOnConnector } from './units'

export interface RateTable {
  base: string
  rates: Record<string, number>
  fetchedAt: number
}

/** Currency symbols mapped to the ISO code they conventionally mean in a
 * calculator context. `$` is ambiguous across many currencies in
 * reality; USD is the common default the way most calculators treat it. */
const CURRENCY_SYMBOLS: readonly [string, string][] = [
  ['$', 'USD'],
  ['€', 'EUR'],
  ['£', 'GBP'],
  ['¥', 'JPY'],
  ['₫', 'VND'],
]

function isKnownCurrency(code: string, table: RateTable): boolean {
  return code.toUpperCase() === table.base.toUpperCase() || code in table.rates
}

function rateFor(table: RateTable, code: string): number | undefined {
  if (code.toUpperCase() === table.base.toUpperCase()) return 1.0
  return table.rates[code]
}

/** Parses the amount+currency side that carries the value — either order
 * (`"100 usd"`, `"usd100"`), currency as a code or a symbol. */
function parseAmountAndCurrency(text: string, table: RateTable, fmt: NumberFormat): [number, string] | undefined {
  const trimmed = text.trim()

  // Symbol glued to the front: "$100", "€50".
  for (const [symbol, code] of CURRENCY_SYMBOLS) {
    if (trimmed.startsWith(symbol) && isKnownCurrency(code, table)) {
      const amount = evalValue(trimmed.slice(symbol.length).trim(), fmt)
      if (amount !== undefined) return [amount, code]
    }
  }

  // A 3-letter code glued directly to a digit: "USD1K".
  if (trimmed.length > 3) {
    const prefix = trimmed.slice(0, 3)
    const rest = trimmed.slice(3)
    if (/^[a-zA-Z]{3}$/.test(prefix) && /^\d/.test(rest)) {
      const code = prefix.toUpperCase()
      if (isKnownCurrency(code, table)) {
        const amount = evalValue(rest, fmt)
        if (amount !== undefined) return [amount, code]
      }
    }
  }

  // Trailing code, space-separated or glued: "100 usd", "1.5k eur".
  let unitStart = -1
  for (let i = trimmed.length - 1; i >= 0; i--) {
    if (!/[a-zA-Z]/.test(trimmed[i] ?? '')) {
      unitStart = i + 1
      break
    }
  }
  if (unitStart !== -1 && unitStart < trimmed.length) {
    const code = trimmed.slice(unitStart).toUpperCase()
    if (isKnownCurrency(code, table)) {
      const amount = evalValue(trimmed.slice(0, unitStart).trim(), fmt)
      if (amount !== undefined) return [amount, code]
    }
  }

  return undefined
}

function parseCurrencyCode(text: string, table: RateTable): string | undefined {
  const trimmed = text.trim()
  for (const [symbol, code] of CURRENCY_SYMBOLS) {
    if (trimmed === symbol) return isKnownCurrency(code, table) ? code : undefined
  }
  const code = trimmed.toUpperCase()
  return isKnownCurrency(code, table) ? code : undefined
}

export function tryEval(query: string, fmt: NumberFormat, table: RateTable | undefined): Calculation | undefined {
  if (!table) return undefined
  const trimmed = query.trim()
  const split = splitOnConnector(trimmed)
  if (!split) return undefined
  const [left, right] = split

  const parsed = parseAmountAndCurrency(left, table, fmt)
  if (!parsed) return undefined
  const [amount, fromCode] = parsed
  const toCode = parseCurrencyCode(right, table)
  if (!toCode) return undefined

  const fromRate = rateFor(table, fromCode)
  const toRate = rateFor(table, toCode)
  if (fromRate === undefined || toRate === undefined) return undefined
  const result = (amount / fromRate) * toRate

  return {
    expression: trimmed,
    result: `${formatGrouped(result, fmt)} ${toCode}`,
    resultRaw: formatRaw(result),
  }
}
