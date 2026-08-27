/**
 * Tracks whether a transient overlay (currently the Actions panel) is on
 * screen, so the view underneath can leave Escape alone while one is up.
 *
 * A shared counter rather than props because the panel is opened by
 * whichever view owns the selection — the main palette in one case, a
 * sub-view like Clipboard History in another — while the Escape handler
 * that would navigate away lives in `App`. Window keydown listeners fire
 * in registration order, so `App`'s handler runs *before* the panel's own
 * and can't rely on `defaultPrevented` to know the panel wants the key.
 */
let openCount = 0

/** Call on mount; the returned function unregisters on unmount. */
export function registerOverlay(): () => void {
  openCount += 1
  let released = false
  return () => {
    if (released) return
    released = true
    openCount -= 1
  }
}

export function isOverlayOpen(): boolean {
  return openCount > 0
}
