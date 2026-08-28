import { afterEach, describe, expect, it } from 'vitest'
import { resolveVisual } from './resolveVisual'

afterEach(() => {
  delete document.documentElement.dataset.theme
})

describe('resolveVisual', () => {
  it('passes a bare string through', () => {
    // Covers every one-string form at once: emoji, hex swatch, URL,
    // absolute path, and an `Icon` name (the enum is only strings).
    expect(resolveVisual('trash')).toEqual({ source: 'trash' })
    expect(resolveVisual('🌐')).toEqual({ source: '🌐' })
  })

  it('reads { source, tintColor }', () => {
    expect(resolveVisual({ source: 'circle', tintColor: '#FF453A' })).toEqual({
      source: 'circle',
      tint: '#FF453A',
    })
  })

  it('picks the themed asset for a { light, dark } source', () => {
    // This shape used to reach the renderer as an object where a string
    // was expected and threw on `.startsWith`, taking down the whole
    // mounted command rather than just its icon.
    const icon = { source: { light: 'day.png', dark: 'night.png' } }

    document.documentElement.dataset.theme = 'dark'
    expect(resolveVisual(icon).source).toBe('night.png')

    document.documentElement.dataset.theme = 'light'
    expect(resolveVisual(icon).source).toBe('day.png')
  })

  it('falls back to the other half of a partly specified pair', () => {
    document.documentElement.dataset.theme = 'dark'
    expect(resolveVisual({ source: { light: 'day.png' } }).source).toBe('day.png')
  })

  it('keeps the tint alongside a themed source', () => {
    document.documentElement.dataset.theme = 'dark'
    expect(resolveVisual({ source: { light: 'a.png', dark: 'b.png' }, tintColor: '#30D158' })).toEqual({
      source: 'b.png',
      tint: '#30D158',
    })
  })

  it('reads { fileIcon } as the path it names', () => {
    expect(resolveVisual({ fileIcon: '/home/u/notes.md' }).source).toBe('/home/u/notes.md')
  })

  it('uses fallback when the source resolves to nothing', () => {
    expect(resolveVisual({ source: undefined, fallback: 'circle' }).source).toBe('circle')
  })

  it('carries a mask through', () => {
    expect(resolveVisual({ source: 'a.png', mask: 'circle' }).mask).toBe('circle')
    expect(resolveVisual({ source: 'a.png', mask: 'roundedRectangle' }).mask).toBe('roundedRectangle')
  })

  it('ignores a mask value it does not recognise', () => {
    expect(resolveVisual({ source: 'a.png', mask: 'triangle' }).mask).toBeUndefined()
  })

  it('applies the mask to a fallback too, as Raycast does', () => {
    expect(resolveVisual({ fallback: 'circle-icon', mask: 'circle' })).toMatchObject({
      source: 'circle-icon',
      mask: 'circle',
    })
  })

  it('yields an empty source for anything it cannot read', () => {
    // The caller renders nothing for an empty source, which is the right
    // outcome for a shape we do not understand.
    expect(resolveVisual(undefined).source).toBe('')
    expect(resolveVisual(null).source).toBe('')
    expect(resolveVisual(42).source).toBe('')
    expect(resolveVisual({}).source).toBe('')
  })
})
