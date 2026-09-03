import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { useScrollIntoViewWhenSelected } from './useListNavigation'

/**
 * The bug this covers: the palette's group heading ("Suggestions" on an
 * empty query) sits inside the scrolling list, above the first row. Hide
 * the palette mid-list and reopen it, and the selection pops back to the
 * first row — which `scrollIntoView({ block: 'nearest' })` satisfied by
 * scrolling the row's own top edge to the top of the list, leaving the
 * heading just above the fold.
 */

let container: HTMLDivElement | null = null
let root: Root | null = null

function Row({ selected }: { selected: boolean }) {
  const ref = useScrollIntoViewWhenSelected<HTMLDivElement>(selected)
  return <div ref={ref} className="row" />
}

/** jsdom does no layout, so the scroller's geometry is stubbed: a 100px
 *  viewport holding a 20px heading and rows of 30px each. */
function renderRow(rowIndex: number, scrollTop: number, clientHeight = 100) {
  container = document.createElement('div')
  document.body.appendChild(container)

  const scroller = document.createElement('div')
  scroller.style.overflowY = 'auto'
  Object.defineProperty(scroller, 'clientHeight', { value: clientHeight, writable: true })
  Object.defineProperty(scroller, 'clientTop', { value: 0 })
  scroller.getBoundingClientRect = () => ({ top: 0 }) as DOMRect
  scroller.scrollTop = scrollTop
  container.appendChild(scroller)

  const mount = document.createElement('div')
  scroller.appendChild(mount)
  root = createRoot(mount)

  const rowTop = 20 + rowIndex * 30 - scrollTop
  const scrollIntoView = vi.fn()
  Element.prototype.scrollIntoView = scrollIntoView

  act(() => root!.render(<Row selected />))
  const row = scroller.querySelector<HTMLDivElement>('.row')!
  Object.defineProperty(row, 'offsetHeight', { value: 30 })
  row.getBoundingClientRect = () => ({ top: rowTop }) as DOMRect

  // Re-run the effect now that the row's geometry is in place.
  act(() => root!.render(<Row selected={false} />))
  scrollIntoView.mockClear()
  act(() => root!.render(<Row selected />))

  return { scroller, scrollIntoView }
}

/** jsdom ships no `ResizeObserver`; this one just records its observers so
 *  a test can fire them, which is all the hook asks of it. */
let resizeCallbacks: (() => void)[] = []

beforeEach(() => {
  resizeCallbacks = []
  vi.stubGlobal(
    'ResizeObserver',
    class {
      callback: () => void
      constructor(callback: () => void) {
        this.callback = callback
      }
      observe() {
        resizeCallbacks.push(this.callback)
      }
      disconnect() {
        resizeCallbacks = resizeCallbacks.filter((c) => c !== this.callback)
      }
    },
  )
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
  vi.unstubAllGlobals()
})

describe('useScrollIntoViewWhenSelected', () => {
  it('winds the list home for a row that fits above the fold, keeping the heading visible', () => {
    const { scroller, scrollIntoView } = renderRow(0, 200)

    expect(scroller.scrollTop).toBe(0)
    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it('scrolls to a row that cannot be reached from the top of the list', () => {
    const { scroller, scrollIntoView } = renderRow(20, 200)

    expect(scroller.scrollTop).toBe(200)
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
  })

  /**
   * The palette builds its root list before the window is ever shown, where
   * the list reports no height: nothing "fits with the list wound home", so
   * the `nearest` fallback parks the list at the selected row's own top edge
   * and the heading ends up above the fold. Showing the window re-runs no
   * effect, so that is what the first open rendered.
   */
  it('re-measures when the list finally gets a height, instead of leaving the heading above the fold', () => {
    const { scroller, scrollIntoView } = renderRow(0, 37, 0)

    // Measured with no height, nothing fits from the top of the list, so
    // even the first row takes the `nearest` branch — which is what parks
    // the real list at that row's own edge, heading out of view.
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })

    // The window is shown: the list gets its real height.
    Object.defineProperty(scroller, 'clientHeight', { value: 100, writable: true })
    act(() => resizeCallbacks.forEach((fire) => fire()))

    expect(scroller.scrollTop).toBe(0)
  })

  it('leaves a row that genuinely needs scrolling where it is when the list resizes', () => {
    const { scroller, scrollIntoView } = renderRow(20, 200)
    scrollIntoView.mockClear()

    act(() => resizeCallbacks.forEach((fire) => fire()))

    expect(scroller.scrollTop).toBe(200)
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
  })
})
