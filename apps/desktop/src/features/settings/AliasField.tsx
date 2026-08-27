import { useEffect, useRef, useState } from 'react'
import { CloseIcon } from '../../components/icons'

interface AliasFieldProps {
  value: string | null
  onCommit: (alias: string | null) => Promise<void>
}

export function AliasField({ value, onCommit }: AliasFieldProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value ?? '')
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  const startEditing = () => {
    setDraft(value ?? '')
    setError(null)
    setEditing(true)
  }

  const commit = () => {
    const trimmed = draft.trim()
    const next = trimmed === '' ? null : trimmed
    if (next === value) {
      setEditing(false)
      return
    }
    onCommit(next)
      .then(() => setEditing(false))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }

  if (!editing) {
    return (
      <div className="openray-alias-field">
        <button
          type="button"
          className={`openray-alias-button${!value ? ' openray-alias-button--ghost' : ''}`}
          onClick={startEditing}
        >
          {value ?? 'Add Alias'}
        </button>
        {value && (
          <button
            type="button"
            className="openray-alias-clear"
            aria-label="Clear alias"
            onClick={() => onCommit(null).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))}
          >
            <CloseIcon />
          </button>
        )}
        {error && <span className="openray-hotkey-error">{error}</span>}
      </div>
    )
  }

  return (
    <div className="openray-alias-field">
      <input
        ref={inputRef}
        type="text"
        className="openray-alias-input"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            setEditing(false)
          }
        }}
      />
      {error && <span className="openray-hotkey-error">{error}</span>}
    </div>
  )
}
