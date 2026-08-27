import { describe, expect, it } from 'vitest'
import { stripTags, withScheme, WEBPAGE_MAX_CHARS } from '../src/webpage'

describe('stripTags', () => {
  it('strips tags and collapses whitespace', () => {
    const html = '<html><body>  <h1>Title</h1>\n<p>Hello   world.</p></body></html>'
    expect(stripTags(html)).toBe('Title Hello world.')
  })

  it('drops script and style content', () => {
    const html = '<style>.a{color:red}</style><p>Visible</p><script>alert(1)</script>'
    expect(stripTags(html)).toBe('Visible')
  })

  it('truncates to the max char count', () => {
    const html = `<p>${'word '.repeat(10_000)}</p>`
    expect(stripTags(html).length).toBeLessThanOrEqual(WEBPAGE_MAX_CHARS)
  })
})

describe('withScheme', () => {
  it('defaults a bare domain to https', () => {
    expect(withScheme('example.com')).toBe('https://example.com')
    expect(withScheme('example.com/path?q=1')).toBe('https://example.com/path?q=1')
  })

  it('leaves an explicit scheme alone', () => {
    expect(withScheme('https://example.com')).toBe('https://example.com')
    expect(withScheme('http://example.com')).toBe('http://example.com')
  })
})
