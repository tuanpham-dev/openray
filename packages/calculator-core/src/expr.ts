/** The plain arithmetic expression engine: operators, parens, functions,
 * constants, word operators, and number shorthand — ported line-for-line
 * from `application/calculator/expr.rs`. Tried last by the router
 * (`index.ts`'s `evaluate`) — every other interpreter handles a phrase
 * shape more specific than "just evaluate this". */

import { formatGrouped, formatRaw, normalizeForParse, type NumberFormat } from './format'

export interface Calculation {
  expression: string
  result: string
  resultRaw: string
}

/** Completes half-typed parentheses so an expression still evaluates while
 * it's being written: unclosed `(` get closing parens appended, and `)`
 * with no opener get `(` prepended. Both directions matter — the palette
 * evaluates on every keystroke, so `(2+3` should already show a result
 * before the user types the closing paren. */
function balanceParens(input: string): string {
  let missingOpen = 0
  let unclosed = 0

  for (const ch of input) {
    if (ch === '(') unclosed++
    else if (ch === ')') {
      if (unclosed > 0) unclosed--
      else missingOpen++
    }
  }

  if (missingOpen === 0 && unclosed === 0) return input

  return '('.repeat(missingOpen) + input + ')'.repeat(unclosed)
}

function balanced(query: string, fmt: NumberFormat): { expression: string; value: number } | undefined {
  const expression = balanceParens(query.trim())
  const parser = tokenize(expression, fmt)
  if (!parser) return undefined
  const value = new Parser(parser).parse()
  if (value === undefined) return undefined
  return { expression, value }
}

/** Evaluates `query` as a plain expression and returns just the value —
 * what `percent`, `units`, and `currency` reach for to evaluate their own
 * operand sub-strings (`900` in `"52% of 900"`, `10` in `"10ft in m"`). */
export function evalValue(query: string, fmt: NumberFormat): number | undefined {
  return balanced(query, fmt)?.value
}

export function tryEval(query: string, fmt: NumberFormat): Calculation | undefined {
  const result = balanced(query, fmt)
  if (!result) return undefined
  const { expression, value } = result
  return { expression, result: formatGrouped(value, fmt), resultRaw: formatRaw(value) }
}

type FunctionName =
  | 'sqrt'
  | 'cbrt'
  | 'abs'
  | 'round'
  | 'floor'
  | 'ceil'
  | 'ln'
  | 'log10'
  | 'log2'
  | 'exp'
  | 'sin'
  | 'cos'
  | 'tan'
  | 'cot'
  | 'sec'
  | 'csc'
  | 'asin'
  | 'acos'
  | 'atan'
  | 'sinh'
  | 'cosh'
  | 'tanh'
  | 'asinh'
  | 'acosh'
  | 'atanh'

const FUNCTION_WORDS: Record<string, FunctionName> = {
  sqrt: 'sqrt',
  cbrt: 'cbrt',
  abs: 'abs',
  round: 'round',
  floor: 'floor',
  ceil: 'ceil',
  ln: 'ln',
  log: 'log10',
  log2: 'log2',
  exp: 'exp',
  sin: 'sin',
  cos: 'cos',
  tan: 'tan',
  cot: 'cot',
  sec: 'sec',
  csc: 'csc',
  asin: 'asin',
  acos: 'acos',
  atan: 'atan',
  sinh: 'sinh',
  cosh: 'cosh',
  tanh: 'tanh',
  asinh: 'asinh',
  acosh: 'acosh',
  atanh: 'atanh',
}

/** Applies the function, returning `undefined` outside its real domain
 * (e.g. `sqrt` of a negative, `asin` outside [-1, 1]) rather than the NaN
 * JS's own Math methods would produce. */
function applyFunction(name: FunctionName, value: number): number | undefined {
  let result: number
  switch (name) {
    case 'sqrt':
      if (value < 0) return undefined
      result = Math.sqrt(value)
      break
    case 'cbrt':
      result = Math.cbrt(value)
      break
    case 'abs':
      result = Math.abs(value)
      break
    case 'round':
      result = Math.round(value)
      break
    case 'floor':
      result = Math.floor(value)
      break
    case 'ceil':
      result = Math.ceil(value)
      break
    case 'ln':
      if (value <= 0) return undefined
      result = Math.log(value)
      break
    case 'log10':
      if (value <= 0) return undefined
      result = Math.log10(value)
      break
    case 'log2':
      if (value <= 0) return undefined
      result = Math.log2(value)
      break
    case 'exp':
      result = Math.exp(value)
      break
    case 'sin':
      result = Math.sin(value)
      break
    case 'cos':
      result = Math.cos(value)
      break
    case 'tan':
      result = Math.tan(value)
      break
    case 'cot':
      result = 1 / Math.tan(value)
      break
    case 'sec':
      result = 1 / Math.cos(value)
      break
    case 'csc':
      result = 1 / Math.sin(value)
      break
    case 'asin':
      if (value < -1 || value > 1) return undefined
      result = Math.asin(value)
      break
    case 'acos':
      if (value < -1 || value > 1) return undefined
      result = Math.acos(value)
      break
    case 'atan':
      result = Math.atan(value)
      break
    case 'sinh':
      result = Math.sinh(value)
      break
    case 'cosh':
      result = Math.cosh(value)
      break
    case 'tanh':
      result = Math.tanh(value)
      break
    case 'asinh':
      result = Math.asinh(value)
      break
    case 'acosh':
      if (value < 1) return undefined
      result = Math.acosh(value)
      break
    case 'atanh':
      if (value < -1 || value >= 1) return undefined
      result = Math.atanh(value)
      break
  }
  return Number.isFinite(result) ? result : undefined
}

type Token =
  | { kind: 'number'; value: number }
  | { kind: 'plus' }
  | { kind: 'minus' }
  | { kind: 'star' }
  | { kind: 'slash' }
  | { kind: 'percent' }
  | { kind: 'caret' }
  | { kind: 'bang' }
  | { kind: 'mod' }
  /** Postfix `deg`: converts the preceding value from degrees to radians,
   * so `sin(30 deg)` reads the way Raycast's docs show it. */
  | { kind: 'deg' }
  | { kind: 'lparen' }
  | { kind: 'rparen' }
  | { kind: 'func'; name: FunctionName }

function tokensEqualKind(token: Token | undefined, kind: Token['kind']): boolean {
  return token !== undefined && token.kind === kind
}

/** Single-word operators/postfixes, resolved case-insensitively. `divided`
 * is handled separately in the tokenizer since it's only valid as the
 * two-word `divided by`. */
function wordToken(word: string): Token | undefined {
  switch (word) {
    case 'plus':
      return { kind: 'plus' }
    case 'minus':
      return { kind: 'minus' }
    case 'times':
    case 'x':
      return { kind: 'star' }
    case 'mod':
      return { kind: 'mod' }
    case 'power':
      return { kind: 'caret' }
    case 'deg':
    case 'degrees':
      return { kind: 'deg' }
    case 'pi':
      return { kind: 'number', value: Math.PI }
    case 'e':
      return { kind: 'number', value: Math.E }
    default: {
      const fn = FUNCTION_WORDS[word]
      return fn ? { kind: 'func', name: fn } : undefined
    }
  }
}

/** Tokenizes `input` against `fmt`'s decimal/group separators. Returns
 * `undefined` for any character or word it doesn't recognise — an
 * unrecognised word (e.g. a plain search query like "firefox") means the
 * whole thing isn't math, not that math stops partway through. */

/** `Number.parseFloat` accepts trailing garbage ("1.2.3" -> 1.2) where
 * Rust's `str::parse::<f64>()` requires the whole string to be one valid
 * float or fails outright — matters here because the tokenizer's digit
 * run can admit a malformed multi-decimal chunk (two `fmt.decimal`
 * characters). Mirrors the strict parse exactly for the digits-plus-one-
 * optional-dot shape `normalizeForParse` always produces. */
function parseStrictFloat(text: string): number | undefined {
  if (!/^\d+(\.\d+)?$/.test(text)) return undefined
  return Number.parseFloat(text)
}

function tokenize(input: string, fmt: NumberFormat): Token[] | undefined {
  const tokens: Token[] = []
  const chars = Array.from(input)
  let i = 0

  while (i < chars.length) {
    const ch = chars[i]
    if (ch === undefined) break

    if (ch === ' ') {
      i++;
      continue
    }
    if (ch === '+') {
      tokens.push({ kind: 'plus' }); i++; continue
    }
    if (ch === '-') {
      tokens.push({ kind: 'minus' }); i++; continue
    }
    if (ch === '*') {
      tokens.push({ kind: 'star' }); i++; continue
    }
    if (ch === '/') {
      tokens.push({ kind: 'slash' }); i++; continue
    }
    if (ch === '%') {
      tokens.push({ kind: 'percent' }); i++; continue
    }
    if (ch === '^') {
      tokens.push({ kind: 'caret' }); i++; continue
    }
    if (ch === '!') {
      tokens.push({ kind: 'bang' }); i++; continue
    }
    if (ch === '(') {
      tokens.push({ kind: 'lparen' }); i++; continue
    }
    if (ch === ')') {
      tokens.push({ kind: 'rparen' }); i++; continue
    }

    if (/[0-9]/.test(ch) || ch === fmt.decimal) {
      const start = i
      while (i < chars.length) {
        const c = chars[i]
        if (c === undefined) break
        if (/[0-9]/.test(c) || c === fmt.decimal || c === fmt.group) i++
        else break
      }
      const text = chars.slice(start, i).join('')
      const parsed = parseStrictFloat(normalizeForParse(text, fmt))
      if (parsed === undefined) return undefined
      let value = parsed

      // Shorthand suffix, only when glued directly to the number: "10K"
      // is ten thousand, "10 K" is not (and the space would just start a
      // new, unrecognised word token).
      const suffix = chars[i]
      if (suffix === 'k' || suffix === 'K') {
        value *= 1e3; i++
      } else if (suffix === 'm' || suffix === 'M') {
        value *= 1e6; i++
      } else if (suffix === 'b' || suffix === 'B') {
        value *= 1e9; i++
      }
      tokens.push({ kind: 'number', value })
      continue
    }

    if (/[a-zA-Z]/.test(ch)) {
      const start = i
      while (i < chars.length) {
        const c = chars[i]
        if (c === undefined || !/[a-zA-Z]/.test(c)) break
        i++
      }
      const word = chars.slice(start, i).join('').toLowerCase()

      if (word === 'divided') {
        let lookahead = i
        while (lookahead < chars.length && chars[lookahead] === ' ') lookahead++
        const byStart = lookahead
        while (lookahead < chars.length) {
          const c = chars[lookahead]
          if (c === undefined || !/[a-zA-Z]/.test(c)) break
          lookahead++
        }
        const nextWord = chars.slice(byStart, lookahead).join('')
        if (nextWord.toLowerCase() === 'by') {
          tokens.push({ kind: 'slash' })
          i = lookahead
          continue
        }
        return undefined
      }

      const token = wordToken(word)
      if (!token) return undefined
      tokens.push(token)
      continue
    }

    return undefined
  }

  return tokens
}

class Parser {
  private pos = 0
  constructor(private readonly tokens: Token[]) {}

  parse(): number | undefined {
    if (this.tokens.length === 0) return undefined
    const value = this.expression()
    if (value === undefined) return undefined
    if (this.pos !== this.tokens.length) return undefined
    return value
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos]
  }

  private advance(): Token | undefined {
    const token = this.peek()
    this.pos++
    return token
  }

  private expression(): number | undefined {
    let value = this.term()
    if (value === undefined) return undefined
    for (;;) {
      const next = this.peek()
      if (tokensEqualKind(next, 'plus')) {
        this.advance()
        const rhs = this.term()
        if (rhs === undefined) return undefined
        value += rhs
      } else if (tokensEqualKind(next, 'minus')) {
        this.advance()
        const rhs = this.term()
        if (rhs === undefined) return undefined
        value -= rhs
      } else break
    }
    return value
  }

  private term(): number | undefined {
    let value = this.power()
    if (value === undefined) return undefined
    for (;;) {
      const next = this.peek()
      if (tokensEqualKind(next, 'star')) {
        this.advance()
        const rhs = this.power()
        if (rhs === undefined) return undefined
        value *= rhs
      } else if (tokensEqualKind(next, 'slash')) {
        this.advance()
        const divisor = this.power()
        if (divisor === undefined || divisor === 0) return undefined
        value /= divisor
      } else if (tokensEqualKind(next, 'mod')) {
        this.advance()
        const divisor = this.power()
        if (divisor === undefined || divisor === 0) return undefined
        value %= divisor
      } else break
    }
    return value
  }

  private power(): number | undefined {
    const base = this.postfix()
    if (base === undefined) return undefined
    if (tokensEqualKind(this.peek(), 'caret')) {
      this.advance()
      const exponent = this.power()
      if (exponent === undefined) return undefined
      return base ** exponent
    }
    return base
  }

  private postfix(): number | undefined {
    let value = this.unary()
    if (value === undefined) return undefined
    for (;;) {
      const next = this.peek()
      if (tokensEqualKind(next, 'percent')) {
        this.advance()
        value /= 100
      } else if (tokensEqualKind(next, 'bang')) {
        this.advance()
        const f = factorial(value)
        if (f === undefined) return undefined
        value = f
      } else if (tokensEqualKind(next, 'deg')) {
        this.advance()
        value = (value * Math.PI) / 180
      } else break
    }
    return value
  }

  private unary(): number | undefined {
    if (tokensEqualKind(this.peek(), 'minus')) {
      this.advance()
      const value = this.unary()
      return value === undefined ? undefined : -value
    }
    return this.primary()
  }

  private primary(): number | undefined {
    const token = this.advance()
    if (!token) return undefined

    if (token.kind === 'number') return token.value

    if (token.kind === 'lparen') {
      const value = this.expression()
      if (value === undefined) return undefined
      if (!tokensEqualKind(this.advance(), 'rparen')) return undefined
      return value
    }

    if (token.kind === 'func') {
      if (tokensEqualKind(this.peek(), 'lparen')) {
        this.advance()
        const value = this.expression()
        if (value === undefined) return undefined
        if (!tokensEqualKind(this.advance(), 'rparen')) return undefined
        return applyFunction(token.name, value)
      }
      // No parens: bind tightly to the next term only, so
      // "sqrt 16 + 4" is sqrt(16) + 4, not sqrt(16 + 4).
      const value = this.unary()
      if (value === undefined) return undefined
      return applyFunction(token.name, value)
    }

    return undefined
  }
}

function factorial(value: number): number | undefined {
  if (value < 0 || !Number.isInteger(value) || value > 170) return undefined
  let result = 1
  for (let n = value; n > 1; n--) result *= n
  return result
}
