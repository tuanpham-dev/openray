import { useEffect, useRef, useState } from 'react'

interface PassphrasePromptProps {
  /** Export asks twice (a typo would make the file permanently
   *  unreadable) and offers an unencrypted escape hatch; import asks once
   *  and has no such choice to make. */
  mode: 'export' | 'import'
  /** Shown under the fields and left in place while the prompt stays
   *  open — a wrong passphrase should let the user simply try again. */
  error: string | null
  busy: boolean
  onSubmit: (passphrase: string) => void
  /** Export only: write the file with no encryption at all. */
  onSkip?: () => void
  onCancel: () => void
}

export function PassphrasePrompt({ mode, error, busy, onSubmit, onSkip, onCancel }: PassphrasePromptProps) {
  const [passphrase, setPassphrase] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const isExport = mode === 'export'
  const mismatched = isExport && confirmation.length > 0 && passphrase !== confirmation
  const canSubmit = passphrase.length > 0 && !busy && (!isExport || passphrase === confirmation)

  const submit = () => {
    if (canSubmit) onSubmit(passphrase)
  }

  return (
    <div
      className="openray-modal-backdrop"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !busy) onCancel()
      }}
    >
      <div className="openray-modal" role="dialog" aria-modal="true" aria-label={isExport ? 'Encrypt export' : 'Enter passphrase'}>
        <span className="openray-modal-title">{isExport ? 'Encrypt this export?' : 'This file is encrypted'}</span>
        <span className="openray-settings-control-hint">
          {isExport
            ? 'A passphrase encrypts the file so only someone who knows it can read it. There is no way to recover it — if you lose the passphrase, the file is unreadable.'
            : 'Enter the passphrase this file was exported with.'}
        </span>

        <input
          ref={inputRef}
          type="password"
          placeholder="Passphrase"
          value={passphrase}
          disabled={busy}
          onChange={(event) => setPassphrase(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit()
          }}
        />
        {isExport && (
          <input
            type="password"
            placeholder="Confirm passphrase"
            value={confirmation}
            disabled={busy}
            onChange={(event) => setConfirmation(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit()
            }}
          />
        )}

        {mismatched && <span className="openray-hotkey-error">The two passphrases don&rsquo;t match.</span>}
        {error && <span className="openray-hotkey-error">{error}</span>}

        <div className="openray-modal-actions">
          <button type="button" className="openray-form-button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          {isExport && onSkip && (
            <button type="button" className="openray-form-button" disabled={busy} onClick={onSkip}>
              Export without encryption
            </button>
          )}
          <button type="button" className="openray-form-button openray-form-button--primary" disabled={!canSubmit} onClick={submit}>
            {busy ? 'Working…' : isExport ? 'Encrypt & Export' : 'Import'}
          </button>
        </div>
      </div>
    </div>
  )
}
