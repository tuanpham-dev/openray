/** The root-search calculator (https://manual.raycast.com/calculator).
 * Ported from `application/calculator/mod.rs`.
 *
 * `evaluate` tries a sequence of specialised interpreters — percent
 * phrases, unit conversion, currency, time/date queries — before falling
 * back to plain arithmetic; the first one that recognises the query's
 * shape wins. Each interpreter returns `undefined` immediately for text
 * that doesn't match its phrase shape, so an unrelated search query (an
 * app name, a snippet keyword) falls all the way through with no
 * calculator row rather than a wrong one. */

import * as currencyEval from './currency'
import * as percentEval from './percent'
import * as timedateEval from './timedate'
import * as unitsEval from './units'
import { tryEval as exprTryEval, type Calculation } from './expr'
import { detectNumberFormat, type NumberFormat } from './format'
import type { RateTable } from './currency'

export type { Calculation } from './expr'
export type { NumberFormat } from './format'
export type { RateTable } from './currency'

let cachedFormat: NumberFormat | undefined

/** The system's number-formatting locale, detected once — matches native
 * `mod.rs::number_format()`'s `OnceLock`, since it can't change during a
 * sidecar process's lifetime without a restart. */
function numberFormat(): NumberFormat {
  cachedFormat ??= detectNumberFormat()
  return cachedFormat
}

/** `rateTable` is read fresh on every call (never fetched here) — see
 * `currency.ts`'s module doc comment for where the actual fetch/cache
 * lives. `now` defaults to the real clock; tests pass a fixed instant. */
export function evaluate(query: string, rateTable: RateTable | undefined, now: Date = new Date()): Calculation | undefined {
  const trimmed = query.trim()
  if (trimmed === '') return undefined
  const fmt = numberFormat()

  return (
    percentEval.tryEval(trimmed, fmt) ??
    unitsEval.tryEval(trimmed, fmt) ??
    currencyEval.tryEval(trimmed, fmt, rateTable) ??
    timedateEval.tryEval(trimmed, fmt, now) ??
    exprTryEval(trimmed, fmt)
  )
}
