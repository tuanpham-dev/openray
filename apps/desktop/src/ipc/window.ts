import { invoke } from '@tauri-apps/api/core'

export function hidePalette(): Promise<void> {
  return invoke('hide_palette')
}

/** Opens a URL in the user's browser via the backend's opener. */
export function openUrl(url: string): Promise<void> {
  return invoke('open_url', { url })
}

/** T24/T26: closes an extension-owned window — never
 *  `getCurrentWindow().close()` (Tauri's own built-in), which skips this
 *  app's `wake_main_loop()` workaround and leaves the window visible but
 *  unresponsive. See `infrastructure::window::close_extension_window`'s
 *  doc comment. */
export function closeExtensionWindow(windowLabel: string): Promise<void> {
  return invoke('close_extension_window', { windowLabel })
}
