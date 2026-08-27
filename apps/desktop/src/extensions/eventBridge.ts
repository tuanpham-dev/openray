import { listen } from '@tauri-apps/api/event'
import type { UiTreeCommit } from '@openray/protocol'
import { extensionTreeStore } from './registry'

export interface ExtensionToastAction {
  title: string
  /** Absent when the action declared no handler. */
  callbackId?: string
}

export interface ExtensionToastPayload {
  id: string
  style?: 'SUCCESS' | 'FAILURE' | 'ANIMATED'
  title?: string
  message?: string
  hide?: boolean
  primaryAction?: ExtensionToastAction
  secondaryAction?: ExtensionToastAction
}

export interface ExtensionHudPayload {
  title: string
}

export interface ExtensionConfirmAlertPayload {
  requestId: string
  title: string
  message?: string
  primaryButtonTitle: string
  dismissButtonTitle: string
}

let started = false
let unlistenCommit: (() => void) | null = null
let unlistenToast: (() => void) | null = null
let unlistenHud: (() => void) | null = null
let unlistenConfirmAlert: (() => void) | null = null

/**
 * Wires the events Rust forwards from the extension host (see
 * extension_bridge.rs): `extension-ui-commit` (the T20 UI-tree protocol),
 * `extension-toast` (T21's showToast/showHUD), and `extension-confirm-alert`
 * (T11's confirmAlert). Idempotent — safe to call from a component effect
 * that may re-run.
 */
export async function startExtensionEventBridge(
  onToast?: (toast: ExtensionToastPayload) => void,
  onHud?: (hud: ExtensionHudPayload) => void,
  onConfirmAlert?: (alert: ExtensionConfirmAlertPayload) => void,
): Promise<void> {
  if (started) return
  started = true
  unlistenCommit = await listen<UiTreeCommit>('extension-ui-commit', (event) => {
    extensionTreeStore.apply(event.payload)
  })
  unlistenToast = await listen<ExtensionToastPayload>('extension-toast', (event) => {
    onToast?.(event.payload)
  })
  unlistenHud = await listen<ExtensionHudPayload>('extension-hud', (event) => {
    onHud?.(event.payload)
  })
  unlistenConfirmAlert = await listen<ExtensionConfirmAlertPayload>('extension-confirm-alert', (event) => {
    onConfirmAlert?.(event.payload)
  })
}

export function stopExtensionEventBridge(): void {
  unlistenCommit?.()
  unlistenToast?.()
  unlistenHud?.()
  unlistenConfirmAlert?.()
  unlistenCommit = null
  unlistenToast = null
  unlistenHud = null
  unlistenConfirmAlert = null
  started = false
}
