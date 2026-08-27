import { invoke } from '@tauri-apps/api/core'

/** Resolves to the command's declared manifest mode ("view" / "no-view" /
 * "menu-bar") once the launch has been sent to the extension host.
 * `argument` is the argument-bar's collected value, for a command that
 * declared `arguments[]`. */
export function runExtensionCommand(extensionId: string, commandName: string, argument?: string): Promise<string> {
  return invoke('run_extension_command', { extensionId, commandName, argument: argument ?? null })
}

export function unmountExtensionCommand(extensionId: string, commandName: string): Promise<void> {
  return invoke('unmount_extension_command', { extensionId, commandName })
}

/** Answers a `confirmAlert` request the palette's confirm dialog is
 * currently showing — see `ConfirmAlertRegistry`'s doc comment. */
export function resolveConfirmAlert(requestId: string, confirmed: boolean): Promise<void> {
  return invoke('resolve_confirm_alert', { requestId, confirmed })
}

export function invokeExtensionCallback(callbackId: string, args: unknown[] = []): Promise<void> {
  return invoke('invoke_extension_callback', { callbackId, args })
}

/** T24: an extension window's own frontend calls this once its
 * `extension-ui-commit` listener is attached — see
 * `infrastructure::window::open_extension_window`'s doc comment for why
 * Node's window mounter waits on it before mounting anything. */
export function notifyExtensionWindowReady(windowLabel: string): Promise<void> {
  return invoke('notify_extension_window_ready', { windowLabel })
}
