import { describe, expect, test } from 'vitest'
import { clampWithin, customFrame, rectContainsPoint, remapToDisplay, targetFrame, type Rect, type WindowAction } from '../src/index'

// Mirrors src-tauri/src/application/window_management/layout.rs's own
// test table, verbatim, so the two stay obviously in sync.

const WORK: Rect = { x: 0, y: 0, w: 1920, h: 1080 }
const CURRENT: Rect = { x: 100, y: 100, w: 800, h: 600 }

function approxEq(a: number, b: number) {
  expect(Math.abs(a - b)).toBeLessThan(1e-6)
}

describe('layout', () => {
  test('every action variant compiles and runs', () => {
    const actions: WindowAction[] = [
      { kind: 'half', half: 'left' },
      { kind: 'half', half: 'right' },
      { kind: 'half', half: 'top' },
      { kind: 'half', half: 'bottom' },
      { kind: 'quarter', quarter: 'top-left' },
      { kind: 'quarter', quarter: 'top-right' },
      { kind: 'quarter', quarter: 'bottom-left' },
      { kind: 'quarter', quarter: 'bottom-right' },
      { kind: 'sixth', sixth: 'top-left' },
      { kind: 'sixth', sixth: 'top-center' },
      { kind: 'sixth', sixth: 'top-right' },
      { kind: 'sixth', sixth: 'bottom-left' },
      { kind: 'sixth', sixth: 'bottom-center' },
      { kind: 'sixth', sixth: 'bottom-right' },
      { kind: 'third', third: 'first' },
      { kind: 'third', third: 'center' },
      { kind: 'third', third: 'last' },
      { kind: 'two-thirds', twoThirds: 'first' },
      { kind: 'two-thirds', twoThirds: 'last' },
      { kind: 'maximize' },
      { kind: 'almost-maximize' },
      { kind: 'maximize-height' },
      { kind: 'maximize-width' },
      { kind: 'reasonable-size' },
      { kind: 'center' },
      { kind: 'make-larger' },
      { kind: 'make-smaller' },
      { kind: 'move', direction: 'left' },
      { kind: 'move', direction: 'right' },
      { kind: 'move', direction: 'up' },
      { kind: 'move', direction: 'down' },
    ]
    expect(actions.length).toBe(31)
    for (const action of actions) {
      const r = targetFrame(action, CURRENT, WORK, 0, 0)
      expect(r.w).toBeGreaterThanOrEqual(0)
      expect(r.h).toBeGreaterThanOrEqual(0)
    }
  })

  test('halves no gap split the work area exactly', () => {
    const left = targetFrame({ kind: 'half', half: 'left' }, CURRENT, WORK, 0, 0)
    const right = targetFrame({ kind: 'half', half: 'right' }, CURRENT, WORK, 0, 0)
    approxEq(left.w, 960)
    approxEq(right.w, 960)
    approxEq(left.x, 0)
    approxEq(right.x + right.w, 1920)
    approxEq(left.x + left.w, right.x)
  })

  test('halves with gap are separated by exactly the gap', () => {
    const gap = 16
    const left = targetFrame({ kind: 'half', half: 'left' }, CURRENT, WORK, gap, 0)
    const right = targetFrame({ kind: 'half', half: 'right' }, CURRENT, WORK, gap, 0)
    approxEq(left.x, gap)
    approxEq(right.x + right.w, WORK.w - gap)
    approxEq(right.x - (left.x + left.w), gap)
    approxEq(left.y, gap)
    approxEq(left.h, WORK.h - 2 * gap)
  })

  test('quarters with gap tile without overlap', () => {
    const gap = 16
    const tl = targetFrame({ kind: 'quarter', quarter: 'top-left' }, CURRENT, WORK, gap, 0)
    const tr = targetFrame({ kind: 'quarter', quarter: 'top-right' }, CURRENT, WORK, gap, 0)
    const bl = targetFrame({ kind: 'quarter', quarter: 'bottom-left' }, CURRENT, WORK, gap, 0)
    approxEq(tr.x - (tl.x + tl.w), gap)
    approxEq(bl.y - (tl.y + tl.h), gap)
    approxEq(tl.x, gap)
    approxEq(tl.y, gap)
  })

  test('sixths tile three columns two rows', () => {
    const gap = 0
    const tl = targetFrame({ kind: 'sixth', sixth: 'top-left' }, CURRENT, WORK, gap, 0)
    const tc = targetFrame({ kind: 'sixth', sixth: 'top-center' }, CURRENT, WORK, gap, 0)
    const tr = targetFrame({ kind: 'sixth', sixth: 'top-right' }, CURRENT, WORK, gap, 0)
    approxEq(tl.w, 640)
    approxEq(tc.x, tl.x + tl.w)
    approxEq(tr.x + tr.w, WORK.w)
    approxEq(tl.h, 540)
  })

  test('two thirds matches thirds plus gap', () => {
    const gap = 12
    const firstThird = targetFrame({ kind: 'third', third: 'first' }, CURRENT, WORK, gap, 0)
    const centerThird = targetFrame({ kind: 'third', third: 'center' }, CURRENT, WORK, gap, 0)
    const firstTwoThirds = targetFrame({ kind: 'two-thirds', twoThirds: 'first' }, CURRENT, WORK, gap, 0)
    approxEq(firstTwoThirds.x, firstThird.x)
    approxEq(firstTwoThirds.w, firstThird.w + gap + centerThird.w)
  })

  test('halves cycle through half two-thirds third', () => {
    const half = targetFrame({ kind: 'half', half: 'left' }, CURRENT, WORK, 0, 0)
    const twoThirds = targetFrame({ kind: 'half', half: 'left' }, CURRENT, WORK, 0, 1)
    const third = targetFrame({ kind: 'half', half: 'left' }, CURRENT, WORK, 0, 2)
    const repeats = targetFrame({ kind: 'half', half: 'left' }, CURRENT, WORK, 0, 3)
    approxEq(half.w, 960)
    approxEq(twoThirds.w, 1280)
    approxEq(third.w, 640)
    approxEq(repeats.w, half.w)
  })

  test('maximize fills work area minus gap', () => {
    const r = targetFrame({ kind: 'maximize' }, CURRENT, WORK, 10, 0)
    approxEq(r.x, 10)
    approxEq(r.y, 10)
    approxEq(r.w, 1900)
    approxEq(r.h, 1060)
  })

  test('reasonable size caps at 1025 by 900', () => {
    const huge: Rect = { x: 0, y: 0, w: 3840, h: 2160 }
    const r = targetFrame({ kind: 'reasonable-size' }, CURRENT, huge, 0, 0)
    approxEq(r.w, 1025)
    approxEq(r.h, 900)
  })

  test('reasonable size is centered in the work area, not anchored to its origin', () => {
    // A work area under the 1025×900 cap so w/h land at the plain 60%
    // fraction, making the expected centered position easy to state.
    const small: Rect = { x: 200, y: 100, w: 1200, h: 800 }
    const r = targetFrame({ kind: 'reasonable-size' }, CURRENT, small, 0, 0)
    approxEq(r.w, small.w * 0.6)
    approxEq(r.h, small.h * 0.6)
    approxEq(r.x, small.x + (small.w - r.w) / 2)
    approxEq(r.y, small.y + (small.h - r.h) / 2)
  })

  test('almost maximize is ninety percent centered', () => {
    const r = targetFrame({ kind: 'almost-maximize' }, CURRENT, WORK, 0, 0)
    approxEq(r.w, 1728)
    approxEq(r.h, 972)
    approxEq(r.x, (1920 - 1728) / 2)
  })

  test('center keeps size and centers position', () => {
    const r = targetFrame({ kind: 'center' }, CURRENT, WORK, 0, 0)
    approxEq(r.w, CURRENT.w)
    approxEq(r.h, CURRENT.h)
    approxEq(r.x, (1920 - 800) / 2)
    approxEq(r.y, (1080 - 600) / 2)
  })

  test('make larger and smaller scale around the same center', () => {
    const larger = targetFrame({ kind: 'make-larger' }, CURRENT, WORK, 0, 0)
    const smaller = targetFrame({ kind: 'make-smaller' }, CURRENT, WORK, 0, 0)
    approxEq(larger.w, 880)
    approxEq(smaller.w, 720)
    const origCx = CURRENT.x + CURRENT.w / 2
    approxEq(larger.x + larger.w / 2, origCx)
    approxEq(smaller.x + smaller.w / 2, origCx)
  })

  test('move commands go flush to the named edge', () => {
    const left = targetFrame({ kind: 'move', direction: 'left' }, CURRENT, WORK, 0, 0)
    const right = targetFrame({ kind: 'move', direction: 'right' }, CURRENT, WORK, 0, 0)
    approxEq(left.x, 0)
    approxEq(right.x + right.w, 1920)
    approxEq(left.y, CURRENT.y)
  })

  test('clampWithin shrinks an oversized rect', () => {
    const big: Rect = { x: -100, y: -100, w: 5000, h: 5000 }
    const clamped = clampWithin(big, WORK)
    approxEq(clamped.w, WORK.w)
    approxEq(clamped.h, WORK.h)
    approxEq(clamped.x, 0)
    approxEq(clamped.y, 0)
  })

  test('clampWithin repositions an out-of-bounds rect', () => {
    const offscreen: Rect = { x: 1900, y: 1070, w: 200, h: 200 }
    const clamped = clampWithin(offscreen, WORK)
    approxEq(clamped.x + clamped.w, WORK.w)
    approxEq(clamped.y + clamped.h, WORK.h)
  })

  test('rectContainsPoint is half-open', () => {
    const r: Rect = { x: 0, y: 0, w: 100, h: 100 }
    expect(rectContainsPoint(r, 0, 0)).toBe(true)
    expect(rectContainsPoint(r, 99.9, 99.9)).toBe(true)
    expect(rectContainsPoint(r, 100, 100)).toBe(false)
    expect(rectContainsPoint(r, -0.1, 0)).toBe(false)
  })

  test('remapToDisplay scales proportionally', () => {
    const from: Rect = { x: 0, y: 0, w: 1920, h: 1080 }
    const to: Rect = { x: 1920, y: 0, w: 2560, h: 1440 }
    const current: Rect = { x: 0, y: 0, w: 960, h: 1080 }
    const remapped = remapToDisplay(current, from, to)
    approxEq(remapped.x, 1920)
    approxEq(remapped.w, 1280)
    approxEq(remapped.h, 1440)
  })

  test('customFrame percent with explicit position', () => {
    const r = customFrame('percent', 10, 20, 50, 50, WORK)
    approxEq(r.x, 192)
    approxEq(r.y, 216)
    approxEq(r.w, 960)
    approxEq(r.h, 540)
  })

  test('customFrame pixels with no position centers', () => {
    const r = customFrame('pixels', null, null, 400, 300, WORK)
    approxEq(r.x, (1920 - 400) / 2)
    approxEq(r.y, (1080 - 300) / 2)
    approxEq(r.w, 400)
    approxEq(r.h, 300)
  })

  test('customFrame clamps oversized pixel input', () => {
    const r = customFrame('pixels', 1800, 1000, 500, 500, WORK)
    expect(r.x + r.w).toBeLessThanOrEqual(WORK.w + 1e-6)
    expect(r.y + r.h).toBeLessThanOrEqual(WORK.h + 1e-6)
  })
})
