import { useState, type ReactNode } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { FolderIcon } from '../../components/icons'

interface StringListFieldProps {
  id: string
  placeholder: string
  hint: ReactNode
  values: string[]
  onChange: (values: string[]) => void
  /** The list holds folder paths, so the add row also offers the OS folder
   *  chooser — typing a path by hand stays available for `~`-relative
   *  entries the dialog can't express. */
  directory?: boolean
}

/**
 * An editable list of short strings — folders, file extensions, etc. —
 * shown as removable chips with an add row. Extracted from the
 * `GeneralPane`-private `ScriptDirectoriesField` so Screenshots' two
 * list settings (search scopes, video extensions) can reuse it.
 */
export function StringListField({ id, placeholder, hint, values, onChange, directory }: StringListFieldProps) {
  const [draft, setDraft] = useState('')

  const append = (value: string) => {
    const trimmed = value.trim()
    if (!trimmed || values.includes(trimmed)) return
    onChange([...values, trimmed])
  }

  const add = () => {
    append(draft)
    setDraft('')
  }

  const browse = async () => {
    const picked = await open({ directory: true, multiple: false, title: 'Choose Folder' })
    if (typeof picked === 'string') append(picked)
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
        {directory && (
          <button type="button" className="openray-settings-browse-button" onClick={() => void browse()}>
            <FolderIcon size={14} />
            Choose…
          </button>
        )}
        <button type="button" onClick={add} disabled={!draft.trim()}>
          Add
        </button>
      </div>
      <span className="openray-settings-control-hint">{hint}</span>
    </div>
  )
}
