import { describe, expect, it } from 'vitest'
import { parseCapture } from '../src/capture'

describe('parseCapture', () => {
  it('recognizes the note prefix', () => {
    expect(parseCapture('note buy milk')).toBe('buy milk')
  })

  it('recognizes the assigned alias', () => {
    expect(parseCapture('nt buy milk', 'nt')).toBe('buy milk')
  })

  it('rejects a bare prefix with no text', () => {
    expect(parseCapture('note')).toBeUndefined()
    expect(parseCapture('note   ')).toBeUndefined()
  })

  it('rejects a word that merely starts with the prefix', () => {
    expect(parseCapture('notebook something')).toBeUndefined()
  })

  it('ignores the alias when none is assigned', () => {
    expect(parseCapture('nt buy milk')).toBeUndefined()
  })

  it('is case-insensitive on the prefix', () => {
    expect(parseCapture('NOTE buy milk')).toBe('buy milk')
  })
})
