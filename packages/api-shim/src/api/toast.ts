import { getHostBridge } from '../bridge'
import { registerCallback, unregisterCallback } from '../reconciler'

let nextToastId = 0

export interface ToastActionOptions {
  title: string
  onAction?: () => void
  shortcut?: { modifiers: string[]; key: string }
}

export interface ToastOptions {
  style?: Toast.Style
  title: string
  message?: string | undefined
  primaryAction?: ToastActionOptions
  secondaryAction?: ToastActionOptions
}

// Class + namespace declaration merging: `Toast.Style` is a static member of
// the `Toast` class, matching the real @raycast/api shape extensions expect
// (found used both ways in the T19b/T20 spike — `new Toast({...})` and
// `Toast.Style.Failure`).
export class Toast {
  private _style: Toast.Style
  private _title: string
  private _message: string | undefined
  private _primaryAction: ToastActionOptions | undefined
  private _secondaryAction: ToastActionOptions | undefined
  private id: string | null = null
  /** Stable per instance, so re-showing an updated toast reuses the same
   *  callback ids instead of leaking a new pair each time. */
  private readonly localId = `toast-${nextToastId++}`

  constructor(options: ToastOptions) {
    this._style = options.style ?? Toast.Style.Success
    this._title = options.title
    this._message = options.message
    this._primaryAction = options.primaryAction
    this._secondaryAction = options.secondaryAction
  }

  // Real @raycast/api toasts update live by plain property mutation after
  // `show()` (`toast.style = 'SUCCESS'; toast.title = answer`, exactly what
  // the store-installed `8ball` extension does) — found live-broken (T32)
  // because these were plain fields with no way to notify the host of a
  // change. Each setter fires an async, best-effort `host.toast.update`
  // once `show()` has actually run (`this.id` set); before that, there's
  // nothing shown yet for an update to target, so it's just a local write
  // (the eventual `show()` call reads the current field values itself).
  // Fire-and-forget rather than returning a Promise from the setter — real
  // property assignment is synchronous, matching the real API's own shape.
  get style(): Toast.Style {
    return this._style
  }
  set style(value: Toast.Style) {
    this._style = value
    this.pushUpdate()
  }
  get title(): string {
    return this._title
  }
  set title(value: string) {
    this._title = value
    this.pushUpdate()
  }
  get message(): string | undefined {
    return this._message
  }
  set message(value: string | undefined) {
    this._message = value
    this.pushUpdate()
  }
  get primaryAction(): ToastActionOptions | undefined {
    return this._primaryAction
  }
  set primaryAction(value: ToastActionOptions | undefined) {
    this._primaryAction = value
    this.pushUpdate()
  }
  get secondaryAction(): ToastActionOptions | undefined {
    return this._secondaryAction
  }
  set secondaryAction(value: ToastActionOptions | undefined) {
    this._secondaryAction = value
    this.pushUpdate()
  }

  private pushUpdate(): void {
    if (!this.id) return
    void getHostBridge().call('host.toast.update', { id: this.id, ...this.payload() })
  }

  /** Registers an action's handler and describes it for the host. The
   *  handler stays in the shim; only its id crosses the bridge. */
  private action(slot: 'primary' | 'secondary', action: ToastActionOptions | undefined) {
    const callbackId = `${this.localId}:${slot}`
    if (!action) {
      unregisterCallback(callbackId)
      return undefined
    }
    if (action.onAction) registerCallback(callbackId, action.onAction)
    return { title: action.title, shortcut: action.shortcut, callbackId: action.onAction ? callbackId : undefined }
  }

  private payload(): Record<string, unknown> {
    return {
      style: this.style,
      title: this.title,
      message: this.message,
      primaryAction: this.action('primary', this.primaryAction),
      secondaryAction: this.action('secondary', this.secondaryAction),
    }
  }

  async show(): Promise<void> {
    const result = await getHostBridge().call('host.toast.show', this.payload())
    this.id = typeof result === 'string' ? result : null
  }

  async hide(): Promise<void> {
    unregisterCallback(`${this.localId}:primary`)
    unregisterCallback(`${this.localId}:secondary`)
    if (!this.id) return
    await getHostBridge().call('host.toast.hide', { id: this.id })
  }
}

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace Toast {
  export enum Style {
    Success = 'SUCCESS',
    Failure = 'FAILURE',
    Animated = 'ANIMATED',
  }
}

/**
 * Real @raycast/api supports two call signatures — an options object and a
 * legacy positional form (style, title, message?). Both were observed in
 * the T19b spike (hacker-news uses the object form, password-generator the
 * positional one), so both are supported here.
 */
export function showToast(options: ToastOptions): Promise<Toast>
export function showToast(style: Toast.Style, title: string, message?: string): Promise<Toast>
export async function showToast(
  optionsOrStyle: ToastOptions | Toast.Style,
  maybeTitle?: string,
  maybeMessage?: string,
): Promise<Toast> {
  const options: ToastOptions =
    typeof optionsOrStyle === 'string' ? { style: optionsOrStyle, title: maybeTitle ?? '', message: maybeMessage } : optionsOrStyle
  const toast = new Toast(options)
  await toast.show()
  return toast
}
