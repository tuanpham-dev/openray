/** Percent phrases: `N% of M`, `N% off M`, `N% on M` / `N% tip on M`
 * (https://manual.raycast.com/calculator) — ported from
 * `application/calculator/percent.rs`. Tried before `expr` — a bare `52%`
 * with no keyword falls through to `expr`'s own postfix `%` (divide by
 * 100), unchanged from before this module existed. */

import { evalValue, type Calculation } from './expr'
import { formatGrouped, formatRaw, type NumberFormat } from './format'

type Operation = 'of' | 'off' | 'on'

/** The keyword right after `%`, longest/most-specific first so `"off"`
 * isn't mistaken for the `"of"` prefix it starts with. Covers both `N% on
 * M` and `N% tip on M` under `on` — a tip is just "on" with an extra
 * word, and both mean the same total-including-percentage. */
const KEYWORDS: readonly [string, Operation][] = [
  ['tip on', 'on'],
  ['off', 'off'],
  ['of', 'of'],
  ['on', 'on'],
]

export function tryEval(query: string, fmt: NumberFormat): Calculation | undefined {
  const trimmed = query.trim()
  const percentPos = trimmed.indexOf('%')
  if (percentPos === -1) return undefined

  const nText = trimmed.slice(0, percentPos)
  const afterPercent = trimmed.slice(percentPos + 1).trimStart()
  const afterLower = afterPercent.toLowerCase()

  const match = KEYWORDS.find(([kw]) => afterLower.startsWith(kw) && /\s/.test(afterLower[kw.length] ?? ''))
  if (!match) return undefined
  const [keyword, operation] = match
  const mText = afterPercent.slice(keyword.length).trimStart()

  const n = evalValue(nText, fmt)
  if (n === undefined) return undefined
  const m = evalValue(mText, fmt)
  if (m === undefined) return undefined

  let value: number
  switch (operation) {
    case 'of':
      value = (m * n) / 100
      break
    case 'off':
      value = m * (1 - n / 100)
      break
    case 'on':
      value = m * (1 + n / 100)
      break
  }

  return { expression: trimmed, result: formatGrouped(value, fmt), resultRaw: formatRaw(value) }
}
