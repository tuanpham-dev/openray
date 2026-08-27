import { useEffect, useState } from 'react'
import { notifyExtensionWindowReady } from '../../ipc/extensionHost'
import { closeExtensionWindow } from '../../ipc/window'
import { startExtensionEventBridge, stopExtensionEventBridge } from '../../extensions/eventBridge'
import { ExtensionView } from '../../extensions/TreeRenderer'
import { ThemeProvider } from '../../theme/ThemeProvider'
import '../../theme/tokens.css'
import '../../components/palette.css'
import '../../App.css'

/**
 * T24: the page mounted at `#/extension-window/{label}` —
 * `infrastructure::window::open_extension_window` builds every
 * extension-owned window against this same route, `{label}` matching the
 * window's own Tauri label 1:1. Renders whatever tree Node's
 * `openExtensionWindow` mounts into it (`ExtensionView`, the same
 * List/Grid/Detail/Form renderer the palette uses), reading from this
 * window's own `extensionTreeStore` — a distinct module instance per
 * webview (see `eventBridge.ts`'s doc comment), so this never sees the
 * palette's own tree or vice versa once `ui.commit` routing (T24) tags
 * each commit with its owning window's label.
 */
export function ExtensionWindow() {
  const [label] = useState(() => window.location.hash.replace(/^#\/extension-window\//, ''))

  // Only once this effect has run — meaning `extension-ui-commit` is
  // actually being listened for — does `notifyExtensionWindowReady` tell
  // Node's window mounter it's safe to `mount()` and start streaming
  // commits. Reversing that order (announcing ready before the listener
  // exists) is exactly the race `open_extension_window`'s doc comment
  // describes: the tree's first commit is always a full snapshot, and a
  // snapshot emitted to a page that hasn't attached its listener yet is
  // gone for good.
  useEffect(() => {
    let cancelled = false
    void startExtensionEventBridge().then(() => {
      if (!cancelled) void notifyExtensionWindowReady(label)
    })
    return () => {
      cancelled = true
      stopExtensionEventBridge()
    }
  }, [label])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // Claimed for the same reason as App.tsx's Escape branch: an
        // unclaimed key re-dispatches through WebKitGTK's native path,
        // and this handler destroys the window out from under it.
        event.preventDefault()
        void closeExtensionWindow(label)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [label])

  return (
    <ThemeProvider>
      <ExtensionView />
    </ThemeProvider>
  )
}
