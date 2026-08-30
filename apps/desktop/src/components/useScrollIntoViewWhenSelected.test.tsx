import { afterEach, describe, expect, it, vi } from 'vitest'
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
function renderRow(rowIndex: number, scrollTop: number) {
  container = document.createElement('div')
  document.body.appendChild(container)

  const scroller = document.createElement('div')
  scroller.style.overflowY = 'auto'
  Object.defineProperty(scroller, 'clientHeight', { value: 100 })
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

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
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
})
