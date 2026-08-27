import { describe, expect, it } from 'vitest'
import { translate, TranslateClientError } from '../src/client'

function fakeFetch(body: unknown, status = 200): typeof fetch {
  return (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as unknown as Response) as typeof fetch
}

describe('translate', () => {
  it('parses a single segment response', async () => {
    const body = [[['Hallo', 'hello', null, null, 1]], null, 'en', null, null, null, 1, null, [['en'], null, [1], ['en']]]
    const result = await translate('hello', 'auto', 'de', fakeFetch(body))
    expect(result.translatedText).toBe('Hallo')
    expect(result.detectedSource).toBe('en')
  })

  it('concatenates multiple segments', async () => {
    const body = [[['Hallo ', null, null, null, 1], ['Welt', null, null, null, 1]], null, 'en']
    const result = await translate('hello world', 'auto', 'de', fakeFetch(body))
    expect(result.translatedText).toBe('Hallo Welt')
  })

  it('omits detected source when source was explicit', async () => {
    const body = [[['Bonjour', 'hello', null, null, 1]], null, 'en']
    const result = await translate('hello', 'en', 'fr', fakeFetch(body))
    expect(result.detectedSource).toBeUndefined()
  })

  it('rejects a malformed body with a parse: error', async () => {
    await expect(translate('hello', 'auto', 'en', fakeFetch({ unexpected: 'shape' }))).rejects.toThrow(
      /^parse: unexpected response shape/,
    )
  })

  it('rejects an empty-segments body with a parse: error', async () => {
    await expect(translate('hello', 'auto', 'en', fakeFetch([[], null, 'en']))).rejects.toThrow(
      /^parse: unexpected response shape/,
    )
  })

  it('short-circuits empty text without a request', async () => {
    const neverCalled: typeof fetch = (() => {
      throw new Error('fetch should not have been called')
    }) as unknown as typeof fetch
    const result = await translate('   ', 'auto', 'en', neverCalled)
    expect(result).toEqual({ translatedText: '' })
  })

  it('maps a 429 status to a rate_limited: error', async () => {
    await expect(translate('hello', 'auto', 'en', fakeFetch({}, 429))).rejects.toThrow(TranslateClientError)
    await expect(translate('hello', 'auto', 'en', fakeFetch({}, 429))).rejects.toThrow(/^rate_limited:/)
  })

  it('maps a fetch rejection to a network: error', async () => {
    const failing: typeof fetch = (async () => {
      throw new Error('boom')
    }) as unknown as typeof fetch
    await expect(translate('hello', 'auto', 'en', failing)).rejects.toThrow(/^network: boom/)
  })

  it('maps a non-429 error status to a network: error', async () => {
    await expect(translate('hello', 'auto', 'en', fakeFetch({}, 500))).rejects.toThrow(/^network: HTTP 500/)
  })
})
