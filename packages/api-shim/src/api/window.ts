import { getHostBridge } from '../bridge'

/** A window's rectangle in screen coordinates, plus the opaque id
 * `setFrame`/`getWorkArea`/`setFullscreen` need to act on the same
 * window. Backend-specific (an X11 window id on this build). */
export interface WindowFrame {
  windowId: string
  x: number
  y: number
  width: number
  height: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Whether this session can read/write window geometry at all (e.g.
 * `false` on Wayland). Distinct from whether a window is currently
 * focused — every other call here degrades to `null`/`false` for that
 * on its own; this is the "is the feature available at all" signal a
 * root-provider listing gates its visibility on. */
export async function isAvailable(): Promise<boolean> {
  return (await getHostBridge().call('host.window.isAvailable')) === true
}

/** The window a command should act on and its current frame, or `null`
 * when none can be resolved (nothing focused, the platform doesn't
 * support window management this session, …). */
export async function getFocusedFrame(): Promise<WindowFrame | null> {
  return ((await getHostBridge().call('host.window.getFocusedFrame')) ?? null) as WindowFrame | null
}

/** Applies `rect` to `windowId`. Resolves to whether the write was even
 * dispatched, not whether the window manager honored it exactly. */
export async function setFrame(windowId: string, rect: Rect): Promise<boolean> {
  return (await getHostBridge().call('host.window.setFrame', { windowId, ...rect })) === true
}

/** The usable area (screen minus taskbar/dock/panel) of the display
 * showing `windowId`, or `null` if it can't be determined. */
export async function getWorkArea(windowId: string): Promise<Rect | null> {
  return ((await getHostBridge().call('host.window.getWorkArea', { windowId })) ?? null) as Rect | null
}

/** Raw monitor bounds (not work areas) of every connected display, in a
 * stable order. */
export async function listDisplays(): Promise<Rect[]> {
  return ((await getHostBridge().call('host.window.listDisplays')) ?? []) as Rect[]
}

/** Enters/exits native OS fullscreen for `windowId`. Resolves to whether
 * the request was dispatched. */
export async function setFullscreen(windowId: string, fullscreen: boolean): Promise<boolean> {
  return (await getHostBridge().call('host.window.setFullscreen', { windowId, fullscreen })) === true
}

/** The app-wide Window settings pane's gap/half-cycling preferences —
 * not this extension's own data, so it's read live rather than cached. */
export async function getWindowSettings(): Promise<{ windowGap: number; halfCycling: boolean }> {
  return (await getHostBridge().call('host.window.getSettings')) as { windowGap: number; halfCycling: boolean }
}

/** A single open window, as `extensions/switch-windows` lists it. */
export interface WindowInfo {
  id: string
  title: string
  appName: string
  /** A resolvable file path (an installed app's theme icon) or a
   * `data:image/png;base64,...` URI (a window-specific icon the
   * backend extracted itself, e.g. from X11 `_NET_WM_ICON`) — `null`
   * when neither could be resolved. */
  icon: string | null
}

/** Whether this session can enumerate windows at all (e.g. `false` on
 * Wayland). A distinct capability from `isAvailable()` above — window
 * enumeration vs. window geometry I/O — that happens to share the same
 * underlying platform check on this build but isn't guaranteed to. */
export async function canListWindows(): Promise<boolean> {
  return (await getHostBridge().call('host.window.canListWindows')) === true
}

export async function listWindows(): Promise<WindowInfo[]> {
  return ((await getHostBridge().call('host.window.list')) ?? []) as WindowInfo[]
}

/** Focuses `id` and hides the palette first — required on Linux, where
 * an EWMH window manager won't raise/front a window on activation alone
 * unless the palette is already unmapped. */
export async function focusWindow(id: string): Promise<boolean> {
  return (await getHostBridge().call('host.window.focus', { id })) === true
}

/** Sends a graceful close request. Deliberately does not hide the
 * palette first (unlike `focusWindow`) — matches the native behavior
 * this replaces. */
export async function closeWindow(id: string): Promise<boolean> {
  return (await getHostBridge().call('host.window.close', { id })) === true
}
