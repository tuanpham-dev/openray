// Pure window-placement math — a line-for-line TypeScript port of
// src-tauri/src/application/window_management/layout.rs. No platform I/O:
// every preset's target rectangle, gap insetting, halves size-cycling,
// cross-display remapping, and custom-command unit conversion lives here
// so it's exercised by plain unit tests, matching the Rust module's own
// rationale for keeping this pure. extensions/window-management is the
// only caller.

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Shrinks by `amount` on every side, floored at zero size. */
export function inset(r: Rect, amount: number): Rect {
  const w = Math.max(r.w - 2 * amount, 0)
  const h = Math.max(r.h - 2 * amount, 0)
  return { x: r.x + amount, y: r.y + amount, w, h }
}

/** Shrinks the size to fit inside `bounds` if necessary, then
 * repositions so the whole rect lies within `bounds`. The safety net
 * every preset routes through before a frame is ever handed to the
 * backend — a stale current-frame reading or an odd custom-command
 * input can never push a window off-screen. */
export function clampWithin(r: Rect, bounds: Rect): Rect {
  const w = Math.max(Math.min(r.w, bounds.w), 0)
  const h = Math.max(Math.min(r.h, bounds.h), 0)
  const x = Math.min(Math.max(r.x, bounds.x), bounds.x + bounds.w - w)
  const y = Math.min(Math.max(r.y, bounds.y), bounds.y + bounds.h - h)
  return { x, y, w, h }
}

export type Half = 'left' | 'right' | 'top' | 'bottom'
export type Quarter = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
export type Sixth = 'top-left' | 'top-center' | 'top-right' | 'bottom-left' | 'bottom-center' | 'bottom-right'
export type Third = 'first' | 'center' | 'last'
export type TwoThirds = 'first' | 'last'
export type Direction = 'left' | 'right' | 'up' | 'down'
export type CustomUnit = 'percent' | 'pixels'

/** Every command whose effect is "compute a target rectangle". Restore
 * (recall a saved frame verbatim) and Toggle Fullscreen (a boolean OS
 * state, not a rectangle) aren't rectangle math and are handled directly
 * by the extension's provider instead of through this type. */
export type WindowAction =
  | { kind: 'half'; half: Half }
  | { kind: 'quarter'; quarter: Quarter }
  | { kind: 'sixth'; sixth: Sixth }
  | { kind: 'third'; third: Third }
  | { kind: 'two-thirds'; twoThirds: TwoThirds }
  | { kind: 'maximize' }
  | { kind: 'almost-maximize' }
  | { kind: 'maximize-height' }
  | { kind: 'maximize-width' }
  | { kind: 'reasonable-size' }
  | { kind: 'center' }
  | { kind: 'make-larger' }
  | { kind: 'make-smaller' }
  | { kind: 'move'; direction: Direction }

/** The length of one of `count` equal tiles spanning `total`, with `gap`
 * reserved between every pair of adjacent tiles and on both outer edges
 * — i.e. `count + 1` gaps total. Floored at zero so a gap wider than the
 * available space degrades to zero-size tiles rather than negative ones. */
function tileLength(total: number, gap: number, count: number): number {
  return Math.max((total - gap * (count + 1)) / count, 0)
}

/** The absolute (start, length) of tile `index` (0-based) out of `count`
 * equal tiles spanning `[start, start + total)`, gapped per
 * `tileLength`. Adjacent tiles computed this way are always separated
 * by exactly `gap` and sit exactly `gap` from the outer edges. */
function tileSpan(start: number, total: number, gap: number, count: number, index: number): [number, number] {
  const length = tileLength(total, gap, count)
  const offset = start + gap * (index + 1) + length * index
  return [offset, length]
}

/** Width of a cycling half at `cycleStep` (0 = ½, 1 = ⅔, 2 = ⅓, then
 * repeats). The ⅔ value spans two thirds-tiles plus their shared internal
 * gap, so it lines up exactly with the plain thirds/two-thirds presets at
 * the same gap setting. */
function cycledLength(total: number, gap: number, step: number): number {
  switch (((step % 3) + 3) % 3) {
    case 0:
      return tileLength(total, gap, 2)
    case 1:
      return 2 * tileLength(total, gap, 3) + gap
    default:
      return tileLength(total, gap, 3)
  }
}

function halfRect(half: Half, workArea: Rect, gap: number, cycleStep: number): Rect {
  if (half === 'left' || half === 'right') {
    const w = cycledLength(workArea.w, gap, cycleStep)
    const x = half === 'left' ? workArea.x + gap : workArea.x + workArea.w - gap - w
    return { x, y: workArea.y + gap, w, h: Math.max(workArea.h - 2 * gap, 0) }
  }
  const h = cycledLength(workArea.h, gap, cycleStep)
  const y = half === 'top' ? workArea.y + gap : workArea.y + workArea.h - gap - h
  return { x: workArea.x + gap, y, w: Math.max(workArea.w - 2 * gap, 0), h }
}

const QUARTER_INDEX: Record<Quarter, [number, number]> = {
  'top-left': [0, 0],
  'top-right': [1, 0],
  'bottom-left': [0, 1],
  'bottom-right': [1, 1],
}

function quarterRect(quarter: Quarter, workArea: Rect, gap: number): Rect {
  const [col, row] = QUARTER_INDEX[quarter]
  const [x, w] = tileSpan(workArea.x, workArea.w, gap, 2, col)
  const [y, h] = tileSpan(workArea.y, workArea.h, gap, 2, row)
  return { x, y, w, h }
}

const SIXTH_INDEX: Record<Sixth, [number, number]> = {
  'top-left': [0, 0],
  'top-center': [1, 0],
  'top-right': [2, 0],
  'bottom-left': [0, 1],
  'bottom-center': [1, 1],
  'bottom-right': [2, 1],
}

function sixthRect(sixth: Sixth, workArea: Rect, gap: number): Rect {
  const [col, row] = SIXTH_INDEX[sixth]
  const [x, w] = tileSpan(workArea.x, workArea.w, gap, 3, col)
  const [y, h] = tileSpan(workArea.y, workArea.h, gap, 2, row)
  return { x, y, w, h }
}

function thirdRect(third: Third, workArea: Rect, gap: number): Rect {
  const index = { first: 0, center: 1, last: 2 }[third]
  const [x, w] = tileSpan(workArea.x, workArea.w, gap, 3, index)
  return { x, y: workArea.y + gap, w, h: Math.max(workArea.h - 2 * gap, 0) }
}

function twoThirdsRect(twoThirds: TwoThirds, workArea: Rect, gap: number): Rect {
  const startIndex = { first: 0, last: 1 }[twoThirds]
  const [x, len] = tileSpan(workArea.x, workArea.w, gap, 3, startIndex)
  return { x, y: workArea.y + gap, w: 2 * len + gap, h: Math.max(workArea.h - 2 * gap, 0) }
}

function centeredFraction(workArea: Rect, fractionW: number, fractionH: number): Rect {
  const w = workArea.w * fractionW
  const h = workArea.h * fractionH
  return { x: workArea.x + (workArea.w - w) / 2, y: workArea.y + (workArea.h - h) / 2, w, h }
}

/** 60% of the work area, capped at 1025×900 — Raycast's own "Reasonable
 * Size" definition. */
function reasonableSize(workArea: Rect): Rect {
  const w = Math.min(workArea.w * 0.6, 1025)
  const h = Math.min(workArea.h * 0.6, 900)
  return centeredFraction({ ...workArea, w, h }, 1, 1)
}

function centerCurrent(current: Rect, workArea: Rect): Rect {
  const x = workArea.x + (workArea.w - current.w) / 2
  const y = workArea.y + (workArea.h - current.h) / 2
  return clampWithin({ x, y, w: current.w, h: current.h }, workArea)
}

/** ±10% of the current size, growing/shrinking around the same center
 * point. */
function scaleCurrent(current: Rect, workArea: Rect, factor: number): Rect {
  const w = current.w * factor
  const h = current.h * factor
  const cx = current.x + current.w / 2
  const cy = current.y + current.h / 2
  return clampWithin({ x: cx - w / 2, y: cy - h / 2, w, h }, workArea)
}

/** Jumps flush against the named work-area edge, keeping size (clamped to
 * fit first, so an oversized window doesn't get pushed further off the
 * opposite edge). */
function moveToEdge(current: Rect, workArea: Rect, direction: Direction): Rect {
  const r = clampWithin(current, workArea)
  switch (direction) {
    case 'left':
      return { ...r, x: workArea.x }
    case 'right':
      return { ...r, x: workArea.x + workArea.w - r.w }
    case 'up':
      return { ...r, y: workArea.y }
    case 'down':
      return { ...r, y: workArea.y + workArea.h - r.h }
  }
}

/** Computes the target rectangle for `action`. `current` is the window's
 * present frame (used by Center/MakeLarger/MakeSmaller/Move, which are
 * relative to it); `gap` and `cycleStep` are ignored by actions that
 * don't use them. */
export function targetFrame(action: WindowAction, current: Rect, workArea: Rect, gap: number, cycleStep: number): Rect {
  switch (action.kind) {
    case 'half':
      return halfRect(action.half, workArea, gap, cycleStep)
    case 'quarter':
      return quarterRect(action.quarter, workArea, gap)
    case 'sixth':
      return sixthRect(action.sixth, workArea, gap)
    case 'third':
      return thirdRect(action.third, workArea, gap)
    case 'two-thirds':
      return twoThirdsRect(action.twoThirds, workArea, gap)
    case 'maximize':
      return inset(workArea, gap)
    case 'almost-maximize':
      return centeredFraction(workArea, 0.9, 0.9)
    case 'maximize-height':
      return clampWithin({ x: current.x, y: workArea.y + gap, w: current.w, h: Math.max(workArea.h - 2 * gap, 0) }, workArea)
    case 'maximize-width':
      return clampWithin({ x: workArea.x + gap, y: current.y, w: Math.max(workArea.w - 2 * gap, 0), h: current.h }, workArea)
    case 'reasonable-size':
      return reasonableSize(workArea)
    case 'center':
      return centerCurrent(current, workArea)
    case 'make-larger':
      return scaleCurrent(current, workArea, 1.1)
    case 'make-smaller':
      return scaleCurrent(current, workArea, 0.9)
    case 'move':
      return moveToEdge(current, workArea, action.direction)
  }
}

/** Whether `(x, y)` falls within `r` (half-open on the far edges) — used
 * to find which display a window's center point currently sits on. */
export function rectContainsPoint(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h
}

/** Proportionally remaps `current` from `fromArea` into the equivalent
 * position/size within `toArea` — Next/Previous Display. Falls back to a
 * plain clamp if `fromArea` is degenerate (shouldn't happen: it's always
 * a real display's work area). */
export function remapToDisplay(current: Rect, fromArea: Rect, toArea: Rect): Rect {
  if (fromArea.w <= 0 || fromArea.h <= 0) {
    return clampWithin(current, toArea)
  }
  const relX = (current.x - fromArea.x) / fromArea.w
  const relY = (current.y - fromArea.y) / fromArea.h
  const relW = current.w / fromArea.w
  const relH = current.h / fromArea.h
  return clampWithin(
    {
      x: toArea.x + relX * toArea.w,
      y: toArea.y + relY * toArea.h,
      w: relW * toArea.w,
      h: relH * toArea.h,
    },
    toArea,
  )
}

/** A custom command's saved geometry, resolved against the current work
 * area. `x`/`y` of `null`/`undefined` centers on that axis (the form's
 * "leave blank to center" affordance). */
export function customFrame(unit: CustomUnit, x: number | null | undefined, y: number | null | undefined, w: number, h: number, workArea: Rect): Rect {
  const [actualW, actualH] = unit === 'percent' ? [(workArea.w * w) / 100, (workArea.h * h) / 100] : [w, h]
  const actualX =
    x !== null && x !== undefined
      ? unit === 'percent'
        ? workArea.x + (workArea.w * x) / 100
        : workArea.x + x
      : workArea.x + (workArea.w - actualW) / 2
  const actualY =
    y !== null && y !== undefined
      ? unit === 'percent'
        ? workArea.y + (workArea.h * y) / 100
        : workArea.y + y
      : workArea.y + (workArea.h - actualH) / 2
  return clampWithin({ x: actualX, y: actualY, w: actualW, h: actualH }, workArea)
}
