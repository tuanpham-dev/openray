import { invoke } from '@tauri-apps/api/core'

/** Resolves to the command's declared manifest mode ("view" / "no-view" /
 * "menu-bar") once the launch has been sent to the extension host.
 * `args` carries the values collected inline in the search bar, keyed by
 * the manifest's own argument names. */
export function runExtensionCommand(
  extensionId: string,
  commandName: string,
  args?: Record<string, string>,
  /** A single value for callers that don't know the field's name — an
   *  inline root row, or Quick AI's Tab shortcut. The backend maps it onto
   *  whichever argument the manifest declares first. */
  positionalArgument?: string,
): Promise<string> {
  return invoke('run_extension_command', {
    extensionId,
    commandName,
    arguments: args ?? null,
    positionalArgument: positionalArgument ?? null,
  })
}

export function unmountExtensionCommand(extensionId: string, commandName: string): Promise<void> {
  return invoke('unmount_extension_command', { extensionId, commandName })
}

/** Answers a `confirmAlert` request the palette's confirm dialog is
 * currently showing — see `ConfirmAlertRegistry`'s doc comment. */
export function resolveConfirmAlert(requestId: string, confirmed: boolean): Promise<void> {
  return invoke('resolve_confirm_alert', { requestId, confirmed })
}

/** Undoes one `Action.Push` in a mounted command — resolves false when the
 *  command is already at its initial view, which is the caller's cue to
 *  leave the command entirely (back to root search). */
export function popExtensionView(extensionId: string, commandName: string): Promise<boolean> {
  return invoke('pop_extension_view', { extensionId, commandName })
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
