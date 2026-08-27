import type { ReactElement } from 'react'
import { globalSlot } from './global-slot'

/**
 * T24: the `Window` shim's own bridge seam, mirroring `bridge.ts`'s
 * HostBridge split exactly (same reason — `runner.ts` and an extension's
 * compiled command are two separate esbuild bundles that each inline their
 * own copy of this file, so a plain module-level variable would be two
 * distinct variables at runtime; a `globalThis` slot is the fix, see
 * `global-slot.ts`'s doc comment).
 *
 * Unlike `HostBridge` (a thin `call(method, params)` wrapper around RPC),
 * this needs real mount/reconciler access — `packages/extension-host`'s
 * `runner.ts` is the only place that has both an `RpcDispatcher` to notify
 * over *and* the process-local `mount()` function from this same package,
 * so it installs the real implementation once at startup
 * (`installWindowMounter`) the same way it installs the HostBridge.
 */
export interface ExtensionWindowOptions {
  title?: string
  width?: number
  height?: number
  decorations?: boolean
  alwaysOnTop?: boolean
  /** Fires once, when Rust reports the native window destroyed (user closed
   *  it, WM killed it, etc.) — the *only* signal a single-instance-reuse
   *  extension (Notes, AI Chat) has that its held-onto handle just went
   *  stale. Without it, `focus()` on a dead window silently no-ops forever
   *  and the extension can never open a fresh one again. Not called for a
   *  close this side itself initiated via `ExtensionWindowHandle.close()`. */
  onClose?: () => void
}

export interface ExtensionWindowHandle {
  /** Tears down the window's own mounted tree and asks Rust to close it.
   *  Safe to call more than once — a second call is a no-op. */
  close(): void
  /** T26: brings the window to the front without touching its mounted
   *  tree — the single-instance-reuse half of a window an extension wants
   *  to toggle rather than recreate per open (Notes: one persistent window,
   *  not a fresh one per note). The extension itself owns "did I already
   *  open a window" (holding onto this handle across calls); this is just
   *  the raw `host.extensionWindow.focus` primitive. */
  focus(): void
}

export interface WindowMounter {
  open(element: ReactElement, options: ExtensionWindowOptions): Promise<ExtensionWindowHandle>
}

const mounterSlot = globalSlot<WindowMounter>('windowMounter')

export function setWindowMounter(mounter: WindowMounter): void {
  mounterSlot.set(mounter)
}

function getWindowMounter(): WindowMounter {
  const mounter = mounterSlot.get()
  if (!mounter) {
    throw new Error('No window mounter configured — call setWindowMounter() before opening an extension window')
  }
  return mounter
}

/** `@openray/extras`'s `openExtensionWindow(element, options)` — see `openray.cts`. */
export function openExtensionWindow(element: ReactElement, options: ExtensionWindowOptions = {}): Promise<ExtensionWindowHandle> {
  return getWindowMounter().open(element, options)
}
