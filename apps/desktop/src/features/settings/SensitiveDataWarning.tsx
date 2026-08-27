import type { PasswordPreference } from '../../ipc/transfer'

interface SensitiveDataWarningProps {
  credentials: PasswordPreference[]
  /** Whether the file is about to be written without encryption — the
   *  same credentials are a much worse idea in a plaintext file, so the
   *  warning says so rather than treating both cases alike. */
  onInclude: () => void
  onExclude: () => void
  onCancel: () => void
}

export function SensitiveDataWarning({ credentials, onInclude, onExclude, onCancel }: SensitiveDataWarningProps) {
  const count = credentials.length

  return (
    <div
      className="openray-modal-backdrop"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel()
      }}
    >
      <div className="openray-modal" role="dialog" aria-modal="true" aria-label="Saved credentials in this export">
        <span className="openray-modal-title">
          {count === 1 ? 'This export includes a saved password' : `This export includes ${count} saved passwords`}
        </span>
        <span className="openray-settings-control-hint">
          These are stored in extension settings. Anyone who can read the exported file can read them, unless you encrypt it
          with a passphrase on the next step.
        </span>

        <ul className="openray-modal-list">
          {credentials.map((credential) => (
            <li key={`${credential.extensionId}:${credential.name}`}>
              <strong>{credential.extensionTitle}</strong> — {credential.name}
            </li>
          ))}
        </ul>

        <div className="openray-modal-actions">
          <button type="button" className="openray-form-button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="openray-form-button" onClick={onInclude}>
            Include them
          </button>
          <button type="button" className="openray-form-button openray-form-button--primary" onClick={onExclude}>
            Export without them
          </button>
        </div>
      </div>
    </div>
  )
}
