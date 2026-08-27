import { useEffect } from 'react'
import { invokeExtensionCallback, resolveConfirmAlert } from '../ipc/extensionHost'
import { registerOverlay } from '../components/overlay'
import type { ExtensionConfirmAlertPayload, ExtensionToastPayload } from './eventBridge'

/**
 * Raycast's toast: a style marker, a title, an optional message, and up to
 * two actions.
 *
 * Actions carry a `callbackId` rather than a function — the handler stays
 * in the extension's own process and is invoked back through the same
 * `extension.invokeCallback` path a rendered `onAction` uses.
 */
export function Toast({ toast, onDismiss }: { toast: ExtensionToastPayload; onDismiss: () => void }) {
  const style = toast.style ?? 'SUCCESS'

  const runAction = (callbackId: string | undefined) => {
    if (callbackId) void invokeExtensionCallback(callbackId, [])
    onDismiss()
  }

  return (
    <div className={`openray-toast openray-toast--${style.toLowerCase()}`} role="status">
      <span className="openray-toast-icon" aria-hidden="true">
        {style === 'ANIMATED' ? (
          <span className="openray-toast-spinner" />
        ) : style === 'FAILURE' ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="4 12 10 18 20 6" />
          </svg>
        )}
      </span>

      <span className="openray-toast-text">
        <span className="openray-toast-title">{toast.title}</span>
        {toast.message && <span className="openray-toast-message">{toast.message}</span>}
      </span>

      {(toast.primaryAction || toast.secondaryAction) && (
        <span className="openray-toast-actions">
          {toast.primaryAction && (
            <button
              type="button"
              className="openray-toast-action openray-toast-action--primary"
              onClick={() => runAction(toast.primaryAction?.callbackId)}
            >
              {toast.primaryAction.title}
            </button>
          )}
          {toast.secondaryAction && (
            <button
              type="button"
              className="openray-toast-action"
              onClick={() => runAction(toast.secondaryAction?.callbackId)}
            >
              {toast.secondaryAction.title}
            </button>
          )}
        </span>
      )}
    </div>
  )
}

/** A HUD is a brief confirmation with no style, actions, or affordances. */
export function Hud({ title }: { title: string }) {
  return (
    <div className="openray-hud" role="status">
      {title}
    </div>
  )
}

/**
 * `host.system.confirmAlert`'s palette surface — a real modal (unlike
 * Toast/HUD): it registers itself as an overlay so `App.tsx`'s global
 * Escape handler leaves navigation alone while it's up, and answers
 * "cancel" on its own Escape rather than letting the key fall through.
 * Rust is synchronously blocked on the answer (see `ConfirmAlertRegistry`),
 * so every path here must eventually call `resolveConfirmAlert` exactly
 * once — a window close/reopen while this is up leaves Rust's `oneshot`
 * receiver to resolve to `false` on its own once the sender drops.
 */
export function ExtensionConfirmAlert({ alert, onResolved }: { alert: ExtensionConfirmAlertPayload; onResolved: () => void }) {
  useEffect(() => registerOverlay(), [])

  const answer = (confirmed: boolean) => {
    void resolveConfirmAlert(alert.requestId, confirmed)
    onResolved()
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        answer(false)
      } else if (event.key === 'Enter') {
        event.preventDefault()
        answer(true)
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [alert.requestId])

  return (
    <div className="openray-confirm-alert-backdrop">
      <div className="openray-confirm-alert" role="alertdialog" aria-modal="true">
        <span className="openray-confirm-alert-title">{alert.title}</span>
        {alert.message && <span className="openray-confirm-alert-message">{alert.message}</span>}
        <div className="openray-confirm-alert-actions">
          <button type="button" className="openray-toast-action" onClick={() => answer(false)}>
            {alert.dismissButtonTitle}
          </button>
          <button type="button" className="openray-toast-action openray-toast-action--primary" onClick={() => answer(true)}>
            {alert.primaryButtonTitle}
          </button>
        </div>
      </div>
    </div>
  )
}
