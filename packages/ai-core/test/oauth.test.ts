import { describe, expect, it } from 'vitest'
import { originOf, parseQueryString, pkceChallenge } from '../src/oauth'

describe('originOf', () => {
  it('strips path and query', () => {
    expect(originOf('https://mcp.example.com/v1/rpc?x=1')).toBe('https://mcp.example.com')
  })

  it('throws for a non-URL', () => {
    expect(() => originOf('not-a-url')).toThrow()
  })
})

describe('pkceChallenge', () => {
  it('is deterministic and URL-safe', () => {
    const challenge = pkceChallenge('fixed-verifier')
    expect(challenge).toBe(pkceChallenge('fixed-verifier'))
    expect(challenge).not.toMatch(/[+/=]/)
  })
})

describe('parseQueryString', () => {
  it('decodes percent-encoded values', () => {
    const params = parseQueryString('code=abc%20123&state=xyz')
    expect(params.code).toBe('abc 123')
    expect(params.state).toBe('xyz')
  })
})
