import { describe, expect, it, vi } from 'vitest'
import { withFallbacks } from '../src/components/namespace-fallback'

describe('withFallbacks', () => {
  it('claims an undefined capitalized member', () => {
    const ns = withFallbacks({} as Record<string, unknown>, (name) => `made:${name}`)
    expect(ns.Trash).toBe('made:Trash')
  })

  it('keeps one identity per member across lookups', () => {
    // A fresh value each time would make React unmount and remount the
    // node on every render.
    const ns = withFallbacks({} as Record<string, unknown>, () => () => null)
    expect(ns.Trash).toBe(ns.Trash)
  })

  it('only calls the factory once per member', () => {
    const make = vi.fn(() => () => null)
    const ns = withFallbacks({} as Record<string, unknown>, make)
    void ns.Trash
    void ns.Trash
    expect(make).toHaveBeenCalledTimes(1)
  })

  it('never shadows a real member', () => {
    const real = () => null
    const ns = withFallbacks({ Style: 'regular', Push: real } as Record<string, unknown>, () => 'made')
    expect(ns.Style).toBe('regular')
    expect(ns.Push).toBe(real)
  })

  it('leaves lower-cased names, symbols and prototype alone', () => {
    // React checks `$$typeof` on values it is handed; claiming these would
    // break its own element detection.
    const ns = withFallbacks(function base() {} as unknown as Record<string, unknown>, () => 'made')
    expect(ns.nope).toBeUndefined()
    expect((ns as unknown as { $$typeof?: unknown }).$$typeof).toBeUndefined()
    expect((ns as unknown as Record<symbol, unknown>)[Symbol.iterator]).toBeUndefined()
    expect(typeof (ns as unknown as { prototype: unknown }).prototype).toBe('object')
  })
})
