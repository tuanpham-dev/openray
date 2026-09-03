/**
 * Raycast-compatible dynamic placeholders, shared by the quicklinks and
 * snippets extensions (https://manual.raycast.com/dynamic-placeholders).
 * A TypeScript port of `src-tauri/src/application/placeholders.rs`,
 * adapted for this host's architecture in two ways:
 *
 * - `Context`'s lookups return `Promise<string>` instead of `string` —
 *   clipboard/selection reads go through the extension host bridge (an
 *   RPC round trip), not a synchronous FFI call, so `expand` is async.
 * - `pseudoUuid` uses Node's built-in `crypto.randomUUID()` rather than
 *   hand-rolling v4 byte-twiddling — the sidecar always runs on Node 20+,
 *   which already produces a spec-compliant v4 UUID directly.
 *
 * Supported tokens: `{clipboard}` / `{clipboard offset=1}`, `{snippet
 * name="..."}` (non-recursive), `{date}` `{time}` `{datetime}` `{day}`
 * (with optional `offset="+2y +5M -3d +4h +30m"`, `format="yyyy-MM-dd"`,
 * `locale="fr-FR"`), `{uuid}`, `{selection}`, `{argument}` (optional
 * `default="..."`, `name="..."` for a named lookup), `{cursor}` (left for
 * the caller to strip — it marks a caret position, not a substitution),
 * `{calculator expression="..."}` (evaluated via `@openray/calculator-core`;
 * no rate table is available here, so a currency phrase won't resolve and
 * falls through unresolved like any other unrecognized token).
 * Modifiers chain with `|`: `uppercase`, `lowercase`, `trim`,
 * `percent-encode`, `json-stringify`, `raw` (opts out of the caller's
 * escaping). Unrecognised `{...}` sequences are left verbatim.
 */

import { randomUUID } from 'node:crypto'
import { evaluate as evaluateCalculator } from '@openray/calculator-core'

export interface Context {
  /** Clipboard text at a history offset: 0 is the live clipboard, N is
   *  the Nth most recent history entry. */
  clipboard: (offset: number) => Promise<string>
  /** Another snippet's body, by name. Omit to disable `{snippet}` — used
   *  to stop recursion when expanding a referenced body. */
  snippet?: (name: string) => Promise<string | undefined>
  /** The active app's selected text. */
  selection: () => Promise<string>
  /** The value the user was prompted for, if any. */
  argument?: string
  /** Lookup for `{argument name="..."}` tokens, so one text can carry
   *  several distinct prompted values (AI Commands). Omit to make a named
   *  token fall back to the single `argument` value, which is what it
   *  always did for quicklinks/snippets. */
  namedArgument?: (name: string) => Promise<string | undefined>
}

/** One value a text prompts for: an `{argument …}` token's identity.
 *  `name: null` is the single unnamed slot — every bare `{argument}` in a
 *  text shares it, matching how `Context.argument` resolves. */
export interface ArgumentSpec {
  name: string | null
  default: string | null
}

interface Token {
  name: string
  attrs: [string, string][]
  modifiers: string[]
}

function tokenAttr(token: Token, key: string): string | undefined {
  return token.attrs.find(([k]) => k === key)?.[1]
}

function isNameChar(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '-'
}

function splitOutsideQuotes(input: string, separator: string): string[] {
  const parts: string[] = []
  let inQuotes = false
  let start = 0
  for (let i = 0; i < input.length; i++) {
    const c = input[i]
    if (c === '"') inQuotes = !inQuotes
    else if (c === separator && !inQuotes) {
      parts.push(input.slice(start, i))
      start = i + 1
    }
  }
  parts.push(input.slice(start))
  return parts
}

/** Parses `{name key="value" key2=bare | mod1 | mod2}` starting at the
 *  `{`. Returns the token and how many characters it spans, or `null` if
 *  this brace doesn't open a well-formed placeholder. */
function parseToken(input: string): [Token, number] | null {
  const innerStart = 1
  let close = -1
  for (let i = innerStart; i < Math.min(input.length, innerStart + 500); i++) {
    const c = input[i]
    if (c === '}') {
      close = i
      break
    }
    if (c === '{' || c === '\n') return null
  }
  if (close === -1) return null
  const inner = input.slice(innerStart, close)
  const consumed = close + 1

  const parts = splitOutsideQuotes(inner, '|')
  const head = parts.shift() ?? ''
  const modifiers = parts.map((p) => p.trim())
  if (modifiers.some((m) => m === '' || ![...m].every(isNameChar))) return null

  const trimmedHead = head.trim()
  let nameEnd = trimmedHead.length
  for (let i = 0; i < trimmedHead.length; i++) {
    if (!isNameChar(trimmedHead[i] ?? '')) {
      nameEnd = i
      break
    }
  }
  const name = trimmedHead.slice(0, nameEnd)
  if (name === '' || !/^[A-Za-z]/.test(name)) return null

  const attrs: [string, string][] = []
  let rest = trimmedHead.slice(nameEnd).trimStart()
  while (rest.length > 0) {
    const eq = rest.indexOf('=')
    if (eq === -1) return null
    const key = rest.slice(0, eq).trim()
    if (key === '' || ![...key].every(isNameChar)) return null
    rest = rest.slice(eq + 1)
    let value: string
    if (rest.startsWith('"')) {
      const stripped = rest.slice(1)
      const end = stripped.indexOf('"')
      if (end === -1) return null
      value = stripped.slice(0, end)
      rest = stripped.slice(end + 1)
    } else {
      const end = rest.search(/\s/)
      value = end === -1 ? rest : rest.slice(0, end)
      rest = end === -1 ? '' : rest.slice(end)
    }
    attrs.push([key, value])
    rest = rest.trimStart()
  }

  return [{ name, attrs, modifiers }, consumed]
}

async function evaluate(token: Token, ctx: Context): Promise<string | undefined> {
  switch (token.name) {
    case 'clipboard': {
      const raw = tokenAttr(token, 'offset')
      const offset = raw === undefined ? 0 : Number.parseInt(raw, 10)
      return ctx.clipboard(Number.isFinite(offset) && offset >= 0 ? offset : 0)
    }
    case 'snippet': {
      if (!ctx.snippet) return undefined
      const name = tokenAttr(token, 'name')
      if (name === undefined) return undefined
      const body = await ctx.snippet(name)
      if (body === undefined) return undefined
      // Expand the referenced body's own placeholders, but with
      // `{snippet}` disabled — Raycast's "non-recursive" rule, and the
      // guard against reference cycles. Expanded unescaped: the value
      // re-enters the outer expansion, which escapes it — escaping here
      // too would double-encode.
      const { snippet: _snippet, ...rest } = ctx
      return expand(body, rest, (v) => v)
    }
    case 'date':
    case 'time':
    case 'datetime':
    case 'day':
      return formatDatetime(token.name, token)
    case 'uuid':
      return pseudoUuid()
    case 'calculator': {
      const expr = tokenAttr(token, 'expression')
      if (expr === undefined) return undefined
      return evaluateCalculator(expr, undefined)?.result
    }
    case 'selection':
      return ctx.selection()
    // Resolution order: the named value (when the token carries `name=`
    // and the context can look names up), then the single unnamed value,
    // then `default`, then empty. Empty strings never shadow a later
    // fallback — an unfilled prompt should reach its default.
    case 'argument': {
      const name = tokenAttr(token, 'name')
      if (name !== undefined && ctx.namedArgument) {
        const named = await ctx.namedArgument(name)
        if (named !== undefined && named !== '') return named
      }
      if (ctx.argument !== undefined && ctx.argument !== '') return ctx.argument
      return tokenAttr(token, 'default') ?? ''
    }
    // A caret marker, not a substitution — the snippet paste path strips
    // it after expansion.
    case 'cursor':
      return undefined
    default:
      return undefined
  }
}

function applyModifiers(value: string, modifiers: string[]): string {
  let result = value
  for (const modifier of modifiers) {
    switch (modifier) {
      case 'uppercase':
        result = result.toUpperCase()
        break
      case 'lowercase':
        result = result.toLowerCase()
        break
      case 'trim':
        result = result.trim()
        break
      case 'percent-encode':
        result = encodeURIComponent(result)
        break
      // Quotes included: the token stands where a JSON string belongs,
      // e.g. `"note": {clipboard | json-stringify}`.
      case 'json-stringify':
        result = JSON.stringify(result)
        break
      // Handled by the caller after the chain runs.
      case 'raw':
        break
      // Tolerate unknown modifiers rather than breaking the paste.
      default:
        break
    }
  }
  return result
}

/** Substituted values pass through `escape`; literal text around them
 *  never does. A `raw` modifier skips `escape` for that one value. */
export async function expand(text: string, ctx: Context, escape: (value: string) => string): Promise<string> {
  let out = ''
  let rest = text

  for (;;) {
    const start = rest.indexOf('{')
    if (start === -1) break
    out += rest.slice(0, start)
    const candidate = rest.slice(start)

    const parsed = parseToken(candidate)
    if (parsed) {
      const [token, consumed] = parsed
      const value = await evaluate(token, ctx)
      if (value !== undefined) {
        const modified = applyModifiers(value, token.modifiers)
        out += token.modifiers.includes('raw') ? modified : escape(modified)
      } else {
        // A syntactically valid token this expansion can't resolve
        // ({cursor}, unknown name, missing snippet): keep it verbatim.
        out += candidate.slice(0, consumed)
      }
      rest = candidate.slice(consumed)
    } else {
      out += '{'
      rest = candidate.slice(1)
    }
  }

  out += rest
  return out
}

/** The distinct values `text` prompts for, in first-appearance order,
 *  deduped by name (all unnamed tokens collapse into one spec). The first
 *  occurrence's `default` wins — later duplicates never override it. */
export function argumentSpecs(text: string): ArgumentSpec[] {
  const specs: ArgumentSpec[] = []
  let rest = text
  while (true) {
    const start = rest.indexOf('{')
    if (start === -1) break
    const candidate = rest.slice(start)
    const parsed = parseToken(candidate)
    if (parsed) {
      const [token, consumed] = parsed
      if (token.name === 'argument') {
        const name = tokenAttr(token, 'name') ?? null
        if (!specs.some((s) => s.name === name)) {
          specs.push({ name, default: tokenAttr(token, 'default') ?? null })
        }
      }
      rest = candidate.slice(consumed)
    } else {
      rest = candidate.slice(1)
    }
  }
  return specs
}

/** Whether `text` contains an `{argument …}` token, meaning the command
 *  should prompt for a value before running. */
export function takesArgument(text: string): boolean {
  return argumentSpecs(text).length > 0
}

/** A random v4 UUID via Node's built-in generator — the sidecar always
 *  runs on a Node new enough to have it. */
export function pseudoUuid(): string {
  return randomUUID()
}

/** The `{cursor}` caret marker, left verbatim by `expand` (it evaluates to
 *  `undefined`, so it survives into the expanded string). */
const CURSOR_MARKER = '{cursor}'

/** Splits an already-expanded string into its final text (every `{cursor}`
 *  marker removed) and the caret offset. The offset is the first marker's
 *  position measured in Unicode code points — not UTF-16 code units — so it
 *  matches a per-code-point caret walk on the consumer side (the Rust
 *  auto-expansion service sends that many Left presses). When there is no
 *  marker the offset is the text length, i.e. the caret stays at the end. */
export function splitCursor(expanded: string): { text: string; cursorOffset: number } {
  const markerIndex = expanded.indexOf(CURSOR_MARKER)
  const text = expanded.split(CURSOR_MARKER).join('')
  // The first marker has no earlier markers before it, so `expanded` up to
  // it is already final text; its code-point length is the offset.
  const cursorOffset = markerIndex === -1 ? [...text].length : [...expanded.slice(0, markerIndex)].length
  return { text, cursorOffset }
}

const DATE_TOKENS: [string, (d: Date, locale: string | undefined) => string][] = [
  ['yyyy', (d) => String(d.getFullYear()).padStart(4, '0')],
  ['yy', (d) => String(d.getFullYear() % 100).padStart(2, '0')],
  ['MMMM', (d, l) => new Intl.DateTimeFormat(l, { month: 'long' }).format(d)],
  ['MMM', (d, l) => new Intl.DateTimeFormat(l, { month: 'short' }).format(d)],
  ['MM', (d) => String(d.getMonth() + 1).padStart(2, '0')],
  ['M', (d) => String(d.getMonth() + 1)],
  ['dd', (d) => String(d.getDate()).padStart(2, '0')],
  ['d', (d) => String(d.getDate())],
  ['EEEE', (d, l) => new Intl.DateTimeFormat(l, { weekday: 'long' }).format(d)],
  ['EEE', (d, l) => new Intl.DateTimeFormat(l, { weekday: 'short' }).format(d)],
  ['E', (d, l) => new Intl.DateTimeFormat(l, { weekday: 'short' }).format(d)],
  ['HH', (d) => String(d.getHours()).padStart(2, '0')],
  ['H', (d) => String(d.getHours())],
  ['hh', (d) => String(hour12(d)).padStart(2, '0')],
  ['h', (d) => String(hour12(d))],
  ['mm', (d) => String(d.getMinutes()).padStart(2, '0')],
  ['m', (d) => String(d.getMinutes())],
  ['ss', (d) => String(d.getSeconds()).padStart(2, '0')],
  ['s', (d) => String(d.getSeconds())],
  ['SSS', (d) => String(d.getMilliseconds()).padStart(3, '0')],
  ['a', (d, l) => dayPeriod(d, l)],
]

function hour12(d: Date): number {
  const h = d.getHours() % 12
  return h === 0 ? 12 : h
}

function dayPeriod(d: Date, locale: string | undefined): string {
  const parts = new Intl.DateTimeFormat(locale, { hour: 'numeric', hour12: true }).formatToParts(d)
  return parts.find((p) => p.type === 'dayPeriod')?.value ?? (d.getHours() < 12 ? 'AM' : 'PM')
}

/** Renders `date` against a Unicode date-format pattern (`yyyy-MM-dd`,
 *  `EEEE`, `h:mm a`, …), the same dialect Raycast's manual documents.
 *  Quoted runs (`'at'`) pass through literally (`''` is an escaped
 *  quote); unrecognised characters pass through as-is. */
function formatWithPattern(date: Date, pattern: string, locale: string | undefined): string {
  let out = ''
  let rest = pattern
  outer: while (rest.length > 0) {
    if (rest.startsWith("'")) {
      const stripped = rest.slice(1)
      const end = stripped.indexOf("'")
      if (end === -1) {
        out += stripped
        rest = ''
      } else {
        out += stripped.slice(0, end)
        rest = stripped.slice(end + 1)
      }
      continue
    }
    for (const [token, render] of DATE_TOKENS) {
      if (rest.startsWith(token)) {
        out += render(date, locale)
        rest = rest.slice(token.length)
        continue outer
      }
    }
    out += rest[0]
    rest = rest.slice(1)
  }
  return out
}

function formatDatetime(name: string, token: Token): string {
  const offset = tokenAttr(token, 'offset')
  const date = offset ? applyOffset(new Date(), offset) : new Date()
  const rawLocale = tokenAttr(token, 'locale')
  // chrono's locales use underscore ids ("fr_FR"); the manual shows BCP
  // 47 ("fr-FR"); Intl accepts either, so no translation is needed here
  // (unlike the Rust side, which has to convert one to the other).
  const locale = rawLocale?.replace(/_/g, '-')

  const format = tokenAttr(token, 'format')
  if (format) return formatWithPattern(date, format, locale)

  // Raycast's human defaults: "1 Jun 2022", "3:05 pm", "1 Jun 2022 at
  // 6:45 pm", "Monday".
  switch (name) {
    case 'date':
      return formatWithPattern(date, 'd MMM yyyy', locale)
    case 'time':
      return formatWithPattern(date, 'h:mm a', locale).toLowerCase()
    case 'datetime':
      return `${formatWithPattern(date, 'd MMM yyyy', locale)} at ${formatWithPattern(date, 'h:mm a', locale).toLowerCase()}`
    default:
      return formatWithPattern(date, 'EEEE', locale)
  }
}

/** Applies `+2y +5M -3d +4h +30m`-style offsets. Unknown or malformed
 *  terms are skipped — a half-right offset beats refusing the paste.
 *  Month/year arithmetic clamps to the target month's last valid day
 *  (e.g. Jan 31 + 1 month → Feb 28/29) rather than leaving the date
 *  unchanged on overflow, unlike the Rust original's `checked_add_months`
 *  — clamping degrades more gracefully for this same "half-right beats
 *  refusing" reasoning, at the cost of exact parity on that one edge
 *  case. */
function applyOffset(when: Date, offset: string): Date {
  let result = new Date(when.getTime())
  for (const term of offset.split(/\s+/).filter(Boolean)) {
    let sign = 1
    let rest = term
    if (rest.startsWith('-')) {
      sign = -1
      rest = rest.slice(1)
    } else if (rest.startsWith('+')) {
      rest = rest.slice(1)
    }
    const unit = rest.slice(-1)
    const amount = Number.parseInt(rest.slice(0, -1), 10)
    if (!Number.isFinite(amount)) continue

    switch (unit) {
      case 'm':
        result = new Date(result.getTime() + sign * amount * 60_000)
        break
      case 'h':
        result = new Date(result.getTime() + sign * amount * 3_600_000)
        break
      case 'd':
        result = new Date(result.getTime() + sign * amount * 86_400_000)
        break
      case 'M':
        result = addMonths(result, sign * amount)
        break
      case 'y':
        result = addMonths(result, sign * amount * 12)
        break
      default:
        break
    }
  }
  return result
}

/** Exported only for direct unit testing of the month-end clamping this
 *  port's `applyOffset` relies on — everything else in this module is
 *  exercised through the public `expand`/`argumentSpecs` surface. */
export function addMonths(date: Date, months: number): Date {
  const result = new Date(date.getTime())
  const day = result.getDate()
  result.setDate(1)
  result.setMonth(result.getMonth() + months)
  const daysInTargetMonth = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate()
  result.setDate(Math.min(day, daysInTargetMonth))
  return result
}
