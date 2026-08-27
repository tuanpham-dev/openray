import { useCallback, useEffect, useRef, useState } from 'react'

/** Rows kept mounted outside the visible viewport on each side, so a fast
 *  arrow-key move or a small scroll doesn't show a blank flash. */
const GRID_OVERSCAN_ROWS = 3
/** Rows rendered on the very first paint of a fresh mount, before the real
 *  `rowHeight` has been measured — only needs to cover one frame, the very
 *  next render corrects it to the real measured window. */
const GRID_INITIAL_GUESS_ROWS = 10

/**
 * Windowed rendering for `ExtensionGrid` (T29) — only the rows near the
 * viewport are mounted, the rest are two full-width spacer elements sized
 * to hold their place in the scrollbar. Ported from native
 * `ScreenshotsView.tsx`'s own `useVirtualizedGrid` (deleted alongside it),
 * generalized for any extension `Grid`: necessary once a grid holds
 * hundreds-to-thousands of items (a real screenshots folder easily does)
 * — mounting every cell at once is slow to render and janky to scroll.
 *
 * Row height isn't a constant: it depends on the rendered cell width
 * (columns ÷ container width, cells are square via `aspect-ratio: 1`), so
 * it's measured from a real rendered cell via `ResizeObserver` rather than
 * computed from CSS constants that would drift if the stylesheet changes.
 *
 * `columns=1` also windows a plain vertical list — the row math reduces to
 * one item per row, which is how Settings' `CommandList` reuses this hook.
 */
export function useVirtualizedGrid(itemCount: number, columns: number) {
  const containerNodeRef = useRef<HTMLDivElement | null>(null)
  const containerObserverRef = useRef<ResizeObserver | null>(null)
  const cellObserverRef = useRef<ResizeObserver | null>(null)
  const [rowHeight, setRowHeight] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  const [scrollTop, setScrollTop] = useState(0)

  // Callback ref, not a plain ref + mount-only effect: a consumer whose
  // itemCount starts at 0 (data still loading) doesn't mount this
  // container until the data arrives, which can be well after this hook's
  // first render. An effect with `[]` deps only ever looks at
  // `containerRef.current` from that first render — if the container
  // wasn't there yet, it never gets observed, `viewportHeight` stays 0
  // forever, and the row-span math collapses to just the overscan buffer
  // (~6 rows) regardless of how tall the container actually is. A callback
  // ref re-fires on every mount, including a late one.
  const containerRef = useCallback((node: HTMLDivElement | null) => {
    containerObserverRef.current?.disconnect()
    containerNodeRef.current = node
    if (!node) return
    setViewportHeight(node.clientHeight)
    const observer = new ResizeObserver(() => setViewportHeight(node.clientHeight))
    observer.observe(node)
    containerObserverRef.current = observer
  }, [])

  useEffect(() => () => containerObserverRef.current?.disconnect(), [])
  useEffect(() => () => cellObserverRef.current?.disconnect(), [])

  // Attached to whichever cell is currently first-in-viewport. Re-attaches
  // (and re-measures) whenever that changes, including across a column-
  // count change — a `ResizeObserver` on the cell itself, not just an
  // on-mount read, so a pure CSS-driven height change is caught without
  // having to guess the right effect deps.
  const measureFirstCell = useCallback((node: HTMLDivElement | null) => {
    cellObserverRef.current?.disconnect()
    if (!node) return
    const observer = new ResizeObserver(() => {
      const container = containerNodeRef.current
      // A flex container with no `gap` set computes `rowGap` as the string
      // "normal", not a length — parseFloat("normal") is NaN, which would
      // otherwise poison rowHeight for good (`NaN > 0` is always false, so
      // the windowing math falls back to a fixed small guess forever).
      const parsedGap = container ? parseFloat(getComputedStyle(container).rowGap) : 0
      const gap = Number.isFinite(parsedGap) ? parsedGap : 0
      setRowHeight(node.getBoundingClientRect().height + gap)
    })
    observer.observe(node)
    cellObserverRef.current = observer
  }, [])

  const onScroll = useCallback(() => {
    if (containerNodeRef.current) setScrollTop(containerNodeRef.current.scrollTop)
  }, [])

  const totalRows = Math.max(1, Math.ceil(itemCount / columns))
  const startRow = rowHeight > 0 ? Math.max(0, Math.floor(scrollTop / rowHeight) - GRID_OVERSCAN_ROWS) : 0
  const visibleRowSpan = rowHeight > 0 ? Math.ceil(viewportHeight / rowHeight) + GRID_OVERSCAN_ROWS * 2 : GRID_INITIAL_GUESS_ROWS
  const endRow = Math.min(totalRows, startRow + visibleRowSpan)

  const startIndex = startRow * columns
  const endIndex = Math.min(itemCount, endRow * columns)
  const topSpacerHeight = startRow * rowHeight
  const bottomSpacerHeight = (totalRows - endRow) * rowHeight

  const scrollIndexIntoView = useCallback(
    (index: number) => {
      const container = containerNodeRef.current
      if (!container || rowHeight === 0) return
      const row = Math.floor(index / columns)
      const rowTop = row * rowHeight
      const rowBottom = rowTop + rowHeight
      if (rowTop < container.scrollTop) {
        container.scrollTop = rowTop
      } else if (rowBottom > container.scrollTop + container.clientHeight) {
        container.scrollTop = rowBottom - container.clientHeight
      }
    },
    [columns, rowHeight],
  )

  return { containerRef, measureFirstCell, onScroll, startIndex, endIndex, topSpacerHeight, bottomSpacerHeight, scrollIndexIntoView }
}
