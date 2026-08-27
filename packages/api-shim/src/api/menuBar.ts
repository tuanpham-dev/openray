import { getHostBridge } from '../bridge'

/** TS mirror of the backend's `MenuBarItem` — a flattened, already
 * mnemonic-stripped leaf from the frontmost app's menu bar. `path` holds
 * its ancestor submenu titles (e.g. `["File", "Recent"]`); `token` is the
 * opaque id `activateMenuItem` expects back. */
export interface MenuBarItem {
  token: string
  title: string
  path: string[]
  shortcut: string | null
  enabled: boolean
}

export interface MenuBarListing {
  appName: string | null
  items: MenuBarItem[]
}

/** Reads the frontmost app's menu bar via the platform's accessibility
 * API (AT-SPI on Linux, Accessibility on macOS, UIA on Windows) — `null`
 * `appName`/an empty `items` list means no target app was resolved, not
 * necessarily an error. Only meaningful when `capabilities.menuBarIntrospection`
 * is `true` — the caller is expected to check that first. */
export async function listMenuBarItems(): Promise<MenuBarListing> {
  return (await getHostBridge().call('host.menuBar.list')) as unknown as MenuBarListing
}

/** Activates `token` (from a `listMenuBarItems()` entry), then hides the
 * palette — that ordering (activate first) is deliberate and matches
 * native: the target app is expected to still be frontmost/focused at the
 * moment the accessibility API fires the activation. */
export async function activateMenuBarItem(token: string): Promise<void> {
  await getHostBridge().call('host.menuBar.activate', { token })
}
