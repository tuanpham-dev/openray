import { describe, expect, it } from 'vitest'
import { deriveTitle } from '../src/title'

describe('deriveTitle', () => {
  it('strips a heading marker', () => {
    expect(deriveTitle('# Meeting notes\nbody')).toBe('Meeting notes')
    expect(deriveTitle('### Deep heading')).toBe('Deep heading')
  })

  it('strips a task list marker', () => {
    expect(deriveTitle('- [ ] ship translate')).toBe('ship translate')
    expect(deriveTitle('- [x] done thing')).toBe('done thing')
  })

  it('strips bullet and ordered markers', () => {
    expect(deriveTitle('- a bullet')).toBe('a bullet')
    expect(deriveTitle('1. first item')).toBe('first item')
  })

  it('falls back to New Note for empty content', () => {
    expect(deriveTitle('')).toBe('New Note')
    expect(deriveTitle('   \n  \n')).toBe('New Note')
    expect(deriveTitle('#')).toBe('New Note')
  })

  it('uses the first non-empty line', () => {
    expect(deriveTitle('\n\n  \nActual title\nsecond line')).toBe('Actual title')
  })

  it('leaves non-heading hash words alone', () => {
    expect(deriveTitle('#tag not a heading')).toBe('#tag not a heading')
  })

  it('strips a blockquote marker', () => {
    expect(deriveTitle('> quoted text')).toBe('quoted text')
  })
})
