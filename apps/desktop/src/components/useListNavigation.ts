import { useEffect, useRef, useState } from 'react'
import { useAppSettings } from '../state/appSettings'
import { suppressHoverSelection } from './hoverSelection'

/**
 * Whether `event` is the Alt+J / Alt+K equivalent of an arrow key.
 *
 * Matches on `event.code` (physical key) rather than `event.key`: with Alt
 * held, `event.key` is layout-dependent and often isn't the letter at all
 * — macOS turns Alt+J into "∆", and Linux layouts with AltGr-style
 * composition can do the same — whereas `code` stays `KeyJ`.
 */
export function altNavigationDirection(event: KeyboardEvent): 1 | -1 | null {
  if (!event.altKey || event.ctrlKey || event.metaKey) return null
  if (event.code === 'KeyJ') return 1
  if (event.code === 'KeyK') return -1
  return null
}

/** The horizontal half of the Vim set — Alt+H / Alt+L — for grid views
 *  where left/right is a real direction. Same `event.code` reasoning as
 *  above. */
export function altHorizontalDirection(event: KeyboardEvent): 1 | -1 | null {
  if (!event.altKey || event.ctrlKey || event.metaKey) return null
  if (event.code === 'KeyL') return 1
  if (event.code === 'KeyH') return -1
  return null
}

/**
 * Keeps the selected row visible. Keyboard navigation only moves an index,
 * so a selection that lands off-screen has to be scrolled to explicitly.
 *
 * `nearest` is what keeps this from fighting the mouse: when the row is
 * already visible — the hover-to-select case, including hovering while
 * wheel-scrolling — it resolves to no scroll at all.
 */
export function useScrollIntoViewWhenSelected<T extends HTMLElement>(selected: boolean) {
  const ref = useRef<T>(null)

  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  return ref
}

/**
 * `resetKey` — typically the search query — reselects the top result
 * whenever it changes. Without this, a selection that lands on (say)
 * index 3 stays at index 3 after a brand-new query replaces the result
 * set with entirely different items: the *count* may not have shrunk
 * (so the itemCount-clamp effect below never fires), but whatever now
 * happens to be at index 3 is highlighted anyway, even though the user
 * never chose it. Omit `resetKey` for a list with no query driving it
 * (e.g. `ActionPanel`'s own action list) — the itemCount clamp alone is
 * still a correct safety net there.
 */
export function useListNavigation(
  itemCount: number,
  onActivate: (index: number, secondary?: boolean, shift?: boolean) => void,
  enabled: boolean = true,
  resetKey?: unknown,
) {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const { altJkNavigation } = useAppSettings()

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    setSelectedIndex(0)
  }, [resetKey])

  useEffect(() => {
    if (selectedIndex >= itemCount) {
      setSelectedIndex(Math.max(0, itemCount - 1))
    }
  }, [itemCount, selectedIndex])

  useEffect(() => {
    if (!enabled) return

    const move = (direction: 1 | -1) => {
      suppressHoverSelection()
      setSelectedIndex((index) => (index + direction + itemCount) % itemCount)
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (itemCount === 0) return

      const altDirection = altJkNavigation ? altNavigationDirection(event) : null
      if (altDirection) {
        event.preventDefault()
        move(altDirection)
      } else if (event.key === 'ArrowDown') {
        event.preventDefault()
        move(1)
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        move(-1)
      } else if (event.key === 'Enter') {
        event.preventDefault()
        onActivate(selectedIndex, event.ctrlKey || event.metaKey, event.shiftKey)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [itemCount, selectedIndex, onActivate, enabled, altJkNavigation])

  return { selectedIndex, setSelectedIndex }
}
