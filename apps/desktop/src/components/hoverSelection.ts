/**
 * Guards list selection against phantom hovers.
 *
 * Rows select on `mouseenter`, but keyboard navigation scrolls the list —
 * and scrolling drags rows underneath a stationary cursor, which fires
 * `mouseenter` on whatever slides under it. The result is that arrowing to
 * an off-screen item immediately snaps the selection back to whatever
 * landed under the mouse.
 *
 * The same phantom-hover problem shows up two more ways, both fixed by
 * the same suppression: a brand-new result list (typing a new query) can
 * render a *different* row under an unmoved cursor, and reopening the
 * palette can do the same if it happens to reappear with a row sitting
 * right under wherever the mouse was left. `SearchBar` calls
 * `suppressHoverSelection()` for both — on every keystroke and on
 * `palette-shown` — so all three cases share one rule: hover-selection
 * stays off until the cursor genuinely moves again.
 *
 * So keyboard navigation, typing, and reopening the palette all suppress
 * hover-selection, and only genuine pointer movement restores it. Note
 * this deliberately compares coordinates rather than just listening for
 * `mousemove`: browsers also emit `mousemove` for a *stationary* pointer
 * when content scrolls beneath it, which would defeat the whole guard.
 */
let enabled = true
let lastX = Number.NaN
let lastY = Number.NaN
let started = false

function start(): void {
  if (started) return
  started = true

  window.addEventListener(
    'mousemove',
    (event) => {
      if (event.clientX === lastX && event.clientY === lastY) return
      lastX = event.clientX
      lastY = event.clientY
      enabled = true
    },
    true,
  )
}

/** Called by keyboard navigation, typing a new query, and the palette
 *  reopening — any of the three owns the selection until the pointer
 *  moves again. */
export function suppressHoverSelection(): void {
  start()
  enabled = false
}

/** Whether a `mouseenter` should be treated as a real hover. */
export function isHoverSelectionEnabled(): boolean {
  start()
  return enabled
}
