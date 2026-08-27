import { useState, type ReactNode } from 'react'

interface StringListFieldProps {
  id: string
  placeholder: string
  hint: ReactNode
  values: string[]
  onChange: (values: string[]) => void
}

/**
 * An editable list of short strings — folders, file extensions, etc. —
 * shown as removable chips with an add row. Extracted from the
 * `GeneralPane`-private `ScriptDirectoriesField` so Screenshots' two
 * list settings (search scopes, video extensions) can reuse it.
 */
export function StringListField({ id, placeholder, hint, values, onChange }: StringListFieldProps) {
  const [draft, setDraft] = useState('')

  const add = () => {
    const value = draft.trim()
    if (!value || values.includes(value)) return
    onChange([...values, value])
    setDraft('')
  }

  return (
    <div className="openray-settings-script-dirs">
      {values.map((value) => (
        <div key={value} className="openray-settings-script-dir">
          <span className="openray-settings-script-dir-path">{value}</span>
          <button
            type="button"
            className="openray-settings-script-dir-remove"
            aria-label={`Remove ${value}`}
            onClick={() => onChange(values.filter((v) => v !== value))}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path d="M2.5 2.5L9.5 9.5M9.5 2.5L2.5 9.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      ))}
      <div className="openray-settings-script-dir-add">
        <input
          id={id}
          type="text"
          placeholder={placeholder}
          value={draft}
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') add()
          }}
        />
        <button type="button" onClick={add} disabled={!draft.trim()}>
          Add
        </button>
      </div>
      <span className="openray-settings-control-hint">{hint}</span>
    </div>
  )
}
