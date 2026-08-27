import { describe, expect, it } from 'vitest'
import { parseIntent } from '../src/intent'
import { LANGUAGES } from '../src/languages'

function lang(code: string) {
  const found = LANGUAGES.find((l) => l.code === code)
  if (!found) throw new Error(`no such language: ${code}`)
  return found
}

describe('parseIntent', () => {
  it('parses the canonical raycast example', () => {
    const intent = parseIntent('hello in german')
    expect(intent?.text).toBe('hello')
    expect(intent?.target.code).toBe('de')
  })

  it('parses into with a language code', () => {
    const intent = parseIntent('how are you into fr')
    expect(intent?.text).toBe('how are you')
    expect(intent?.target.code).toBe('fr')
  })

  it('is lenient by design — a false positive still parses', () => {
    // "log in french" reads as "translate 'log' to French" — accepted
    // per the additive-row design.
    const intent = parseIntent('log in french')
    expect(intent?.text).toBe('log')
    expect(intent?.target.code).toBe('fr')
  })

  it('rejects a query with no in or into', () => {
    expect(parseIntent('plugin')).toBeUndefined()
    expect(parseIntent('hello world')).toBeUndefined()
  })

  it('rejects empty text before in', () => {
    expect(parseIntent('in german')).toBeUndefined()
  })

  it('rejects nothing after in', () => {
    expect(parseIntent('say this into')).toBeUndefined()
  })

  it('rejects an unknown trailing language', () => {
    expect(parseIntent('look in nowhere')).toBeUndefined()
  })

  it('uses the last in when several are present', () => {
    const intent = parseIntent('check in in german')
    expect(intent?.text).toBe('check in')
    expect(intent?.target.code).toBe('de')
  })

  it('translate prefix uses the default target language', () => {
    const intent = parseIntent('translate hello world', lang('es'))
    expect(intent?.text).toBe('hello world')
    expect(intent?.target.code).toBe('es')
  })

  it('translate prefix is case-insensitive', () => {
    const intent = parseIntent('Translate hello', lang('es'))
    expect(intent?.text).toBe('hello')
    expect(intent?.target.code).toBe('es')
  })

  it('explicit language wins over the translate prefix default', () => {
    const intent = parseIntent('translate hello in german', lang('es'))
    expect(intent?.text).toBe('hello')
    expect(intent?.target.code).toBe('de')
  })

  it('translate prefix alone with no text is rejected', () => {
    expect(parseIntent('translate', lang('es'))).toBeUndefined()
  })

  it('translate prefix is rejected without a default target', () => {
    expect(parseIntent('translate hello')).toBeUndefined()
  })

  it('an assigned alias triggers the same prefix form', () => {
    const intent = parseIntent('tr hello world', lang('es'), 'tr')
    expect(intent?.text).toBe('hello world')
    expect(intent?.target.code).toBe('es')
  })

  it('alias matching is case-insensitive', () => {
    const intent = parseIntent('TR hello', lang('es'), 'tr')
    expect(intent?.text).toBe('hello')
    expect(intent?.target.code).toBe('es')
  })

  it('the literal word translate still works when an alias is configured', () => {
    const intent = parseIntent('translate hello', lang('es'), 'tr')
    expect(intent?.text).toBe('hello')
  })

  it('an unset alias does not match an unrelated first word', () => {
    expect(parseIntent('tr hello world', lang('es'))).toBeUndefined()
  })

  it('a word that only happens to match the alias text still requires trailing text', () => {
    expect(parseIntent('tr', lang('es'), 'tr')).toBeUndefined()
  })
})
