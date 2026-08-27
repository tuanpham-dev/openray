import { describe, expect, it } from 'vitest'
import { evaluate } from '../src/index'

describe('evaluate', () => {
  it('evaluates plain arithmetic', () => {
    expect(evaluate('2 + 2', undefined)?.result).toBe('4')
  })

  it('does not treat app names as math', () => {
    expect(evaluate('firefox', undefined)).toBeUndefined()
  })

  it('does not treat empty query as math', () => {
    expect(evaluate('', undefined)).toBeUndefined()
    expect(evaluate('   ', undefined)).toBeUndefined()
  })
})
