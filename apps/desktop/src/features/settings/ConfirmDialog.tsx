import { useEffect, useRef } from 'react'

interface ConfirmDialogProps {
  title: string
  /** Say what the action actually costs, not "are you sure?" — the whole
   *  point of stopping someone is to tell them something they didn't know. */
  message: string
  confirmLabel: string
  /** Tints the confirm button and, more importantly, moves initial focus to
   *  Cancel so a stray Enter can't complete a deletion. */
  destructive?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/**
 * The in-app confirmation Settings uses before anything irreversible.
 *
 * Deliberately not `window.confirm`: in the WebKitGTK webview this app ships,
 * that returns truthy without ever drawing anything, so a guard written
 * against it reads like a confirmation and silently approves everything.
 * Nor the dialog plugin's native `ask` — it works, but a GTK dialog looks
 * like it belongs to a different program than the pane that raised it.
 *
 * Shares `.openray-modal*` with the Import/Export passphrase prompt rather
 * than introducing a second modal style.
 */
export function ConfirmDialog({ title, message, confirmLabel, destructive, onConfirm, onCancel }: ConfirmDialogProps) {
  const backdropRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    // Focus lands on Cancel for a destructive action: the dialog exists to
    // interrupt, and defaulting Enter to the irreversible half would hand
    // the interruption straight back.
    const initial = destructive ? cancelRef.current : confirmRef.current
    initial?.focus()
  }, [destructive])

  return (
    <div
      ref={backdropRef}
      className="openray-modal-backdrop"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel()
      }}
      // Clicking the dimmed area cancels, the way every other modal on the
      // platform behaves — but only the backdrop itself, never a click that
      // merely bubbled up out of the dialog.
      onMouseDown={(event) => {
        if (event.target === backdropRef.current) onCancel()
      }}
    >
      <div className="openray-modal openray-confirm-dialog" role="alertdialog" aria-modal="true" aria-label={title}>
        <span className="openray-modal-title">{title}</span>
        <span className="openray-settings-control-hint">{message}</span>

        <div className="openray-modal-actions">
          <button type="button" ref={cancelRef} className="openray-form-button" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            ref={confirmRef}
            className={`openray-form-button ${destructive ? 'openray-form-button--danger' : 'openray-form-button--primary'}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
