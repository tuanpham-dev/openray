import { describe, expect, it } from 'vitest'
import { addMonths, argumentSpecs, expand, pseudoUuid, splitCursor, takesArgument, type ArgumentSpec, type Context } from '../src/index'

const plain = (value: string) => value

function contextWithClipboard(clipboard: (offset: number) => Promise<string>): Context {
  return { clipboard, selection: async () => '' }
}

function emptyContext(): Context {
  return { clipboard: async () => '', selection: async () => '' }
}

describe('expand', () => {
  it('expands clipboard lazily', async () => {
    const read = async (_offset: number) => 'there'
    expect(await expand('Hi {clipboard}', contextWithClipboard(read), plain)).toBe('Hi there')

    let called = false
    const tracking = async (_offset: number) => {
      called = true
      return ''
    }
    await expand('no tokens', contextWithClipboard(tracking), plain)
    expect(called).toBe(false)
  })

  it('reaches clipboard history via offset', async () => {
    const read = async (offset: number) => `entry-${offset}`
    const expanded = await expand('{clipboard} then {clipboard offset=2}', contextWithClipboard(read), plain)
    expect(expanded).toBe('entry-0 then entry-2')
  })

  it('expands every datetime token', async () => {
    const expanded = await expand('{datetime}|{date}|{time}|{day}', emptyContext(), plain)
    expect(expanded).not.toContain('{')
  })

  it('evaluates a calculator expression', async () => {
    expect(await expand('{calculator expression="2+2*3"}', emptyContext(), plain)).toBe('8')
  })

  it('leaves an unresolvable calculator expression verbatim', async () => {
    // No rate table is available to the placeholder, so a currency phrase
    // can't resolve — same "syntactically valid but unresolvable" fallback
    // as an unknown token name.
    const expanded = await expand('{calculator expression="10 usd to eur"}', emptyContext(), plain)
    expect(expanded).toBe('{calculator expression="10 usd to eur"}')
  })

  it('leaves a calculator token with no expression attribute verbatim', async () => {
    expect(await expand('{calculator}', emptyContext(), plain)).toBe('{calculator}')
  })

  it('formats a date with a unicode pattern', async () => {
    const expanded = await expand('{date format="yyyy-MM-dd"}', emptyContext(), plain)
    expect(expanded).toHaveLength(10)
    expect(expanded[4]).toBe('-')
    const year = Number.parseInt(expanded.slice(0, 4), 10)
    expect(year).toBeGreaterThanOrEqual(2024)
  })

  it('shifts a date offset by years', async () => {
    const thisYear = Number.parseInt(await expand('{date format="yyyy"}', emptyContext(), plain), 10)
    const shifted = Number.parseInt(await expand('{date offset="+2y" format="yyyy"}', emptyContext(), plain), 10)
    expect(shifted).toBe(thisYear + 2)
  })

  it('localizes a month name', async () => {
    const expanded = await expand('{date format="MMMM" locale="fr-FR"}', emptyContext(), plain)
    const frenchMonths = [
      'janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre',
      'octobre', 'novembre', 'décembre',
    ]
    expect(frenchMonths).toContain(expanded)
  })

  it('does not recurse into a referenced snippets own snippet token', async () => {
    const lookup = async (name: string) => (name === 'sig' ? 'Regards, {snippet name="sig"} {uuid}' : undefined)
    const ctx: Context = { clipboard: async () => '', snippet: lookup, selection: async () => '' }
    const expanded = await expand('{snippet name="sig"}', ctx, plain)
    expect(expanded.startsWith('Regards, {snippet name="sig"} ')).toBe(true)
    expect(expanded).not.toContain('{uuid}')
  })

  it('uses the argument value then falls back to a default', async () => {
    const withArg: Context = { clipboard: async () => '', selection: async () => '', argument: 'hello' }
    expect(await expand('q={argument}', withArg, plain)).toBe('q=hello')

    const noArg = emptyContext()
    expect(await expand('q={argument default="fallback"}', noArg, plain)).toBe('q=fallback')
    expect(await expand('q={argument}', noArg, plain)).toBe('q=')
  })

  it('chains modifiers left to right', async () => {
    const read = async (_offset: number) => '  Foo Bar  '
    const ctx = contextWithClipboard(read)
    expect(await expand('{clipboard | trim | uppercase}', ctx, plain)).toBe('FOO BAR')
    expect(await expand('{clipboard | trim | percent-encode}', ctx, plain)).toBe('Foo%20Bar')
    expect(await expand('{clipboard | trim | json-stringify}', ctx, plain)).toBe('"Foo Bar"')
  })

  it('raw modifier skips the callers escape', async () => {
    const read = async (_offset: number) => 'a b'
    const ctx = contextWithClipboard(read)
    const encode = (v: string) => encodeURIComponent(v)
    expect(await expand('{clipboard}', ctx, encode)).toBe('a%20b')
    expect(await expand('{clipboard | raw}', ctx, encode)).toBe('a b')
  })

  it('leaves unknown braces untouched', async () => {
    const text = '{"k": "v"} {nope} {argument bad attr} {cursor}'
    expect(await expand(text, emptyContext(), plain)).toBe(text)
  })

  it('resolves named arguments independently', async () => {
    const lookup = async (name: string) => (name === 'tone' ? 'formal' : name === 'text' ? 'hello there' : undefined)
    const ctx: Context = { clipboard: async () => '', selection: async () => '', namedArgument: lookup }
    const expanded = await expand('Rewrite in a {argument name="tone"} tone: {argument name="text"}', ctx, plain)
    expect(expanded).toBe('Rewrite in a formal tone: hello there')
  })

  it('falls a named argument back to the unnamed value then the default', async () => {
    const lookup = async (_name: string) => undefined
    const ctx: Context = { clipboard: async () => '', selection: async () => '', namedArgument: lookup, argument: 'shared' }
    expect(await expand('{argument name="missing"}', ctx, plain)).toBe('shared')

    const ctxNoArg: Context = { clipboard: async () => '', selection: async () => '', namedArgument: lookup }
    expect(await expand('{argument name="missing" default="dflt"}', ctxNoArg, plain)).toBe('dflt')

    const emptyLookup = async (_name: string) => ''
    const ctxEmpty: Context = { clipboard: async () => '', selection: async () => '', namedArgument: emptyLookup }
    expect(await expand('{argument name="x" default="dflt"}', ctxEmpty, plain)).toBe('dflt')
  })

  it('uses the single value for a named token when there is no lookup', async () => {
    const ctx: Context = { clipboard: async () => '', selection: async () => '', argument: 'value' }
    expect(await expand('{argument name="who"}', ctx, plain)).toBe('value')
  })
})

describe('argumentSpecs / takesArgument', () => {
  it('dedupes by name and preserves first-appearance order', () => {
    const specs = argumentSpecs(
      '{argument name="b" default="x"} then {argument} then {argument name="a"} then {argument name="b" default="ignored"} and {argument}',
    )
    const expected: ArgumentSpec[] = [
      { name: 'b', default: 'x' },
      { name: null, default: null },
      { name: 'a', default: null },
    ]
    expect(specs).toEqual(expected)
    expect(argumentSpecs('no tokens, and {arguments} doesnt count')).toEqual([])
  })

  it('detects every attribute form', () => {
    expect(takesArgument('https://x.test/?q={argument}')).toBe(true)
    expect(takesArgument('Hi {argument name="who" default="you"}!')).toBe(true)
    expect(takesArgument('no tokens here')).toBe(false)
    expect(takesArgument('{arguments} {argumentative}')).toBe(false)
  })
})

describe('addMonths', () => {
  it('clamps to the target months last valid day instead of overflowing into the next month', () => {
    const jan31 = new Date(2024, 0, 31)
    const result = addMonths(jan31, 1)
    // 2024 is a leap year: Feb has 29 days.
    expect(result.getMonth()).toBe(1)
    expect(result.getDate()).toBe(29)
  })

  it('leaves a day that exists in the target month untouched', () => {
    const jan15 = new Date(2024, 0, 15)
    const result = addMonths(jan15, 1)
    expect(result.getMonth()).toBe(1)
    expect(result.getDate()).toBe(15)
  })

  it('subtracts months symmetrically for a negative amount', () => {
    const mar31 = new Date(2024, 2, 31)
    const result = addMonths(mar31, -1)
    // Feb 2024 has 29 days.
    expect(result.getMonth()).toBe(1)
    expect(result.getDate()).toBe(29)
  })
})

describe('pseudoUuid', () => {
  it('is v4-shaped and unique', () => {
    const first = pseudoUuid()
    const second = pseudoUuid()
    expect(first).not.toBe(second)
    expect(first).toHaveLength(36)
    expect(first[14]).toBe('4')
  })
})

describe('splitCursor', () => {
  it('removes the marker and reports its position for a mid-text cursor', () => {
    const { text, cursorOffset } = splitCursor('Hello {cursor}world')
    expect(text).toBe('Hello world')
    expect(cursorOffset).toBe(6)
  })

  it('puts the caret at the end when there is no marker', () => {
    const { text, cursorOffset } = splitCursor('Best, me')
    expect(text).toBe('Best, me')
    expect(cursorOffset).toBe(8)
  })

  it('strips every marker but positions at the first', () => {
    const { text, cursorOffset } = splitCursor('a{cursor}b{cursor}c')
    expect(text).toBe('abc')
    expect(cursorOffset).toBe(1)
  })

  it('counts the offset in code points, not UTF-16 units', () => {
    // "😀" is one code point but two UTF-16 units.
    const { text, cursorOffset } = splitCursor('😀{cursor}x')
    expect(text).toBe('😀x')
    expect(cursorOffset).toBe(1)
  })
})
