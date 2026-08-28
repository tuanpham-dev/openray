import { StringListField } from './StringListField'
import { updateSettings, type Settings } from '../../ipc/settings'

interface FileSearchPrefsProps {
  settings: Settings
  onChange: (settings: Settings) => void
}

export function FileSearchPrefs({ settings, onChange }: FileSearchPrefsProps) {
  const save = (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch }
    onChange(next)
    void updateSettings(next)
  }

  return (
    <div className="openray-settings-form">
      <label className="openray-settings-form-label openray-settings-form-label--top" htmlFor="file-search-scopes-input">
        Search Scopes
      </label>
      <StringListField
        id="file-search-scopes-input"
        directory
        placeholder="~/Projects"
        hint="Folders scanned for files by name. Search Files stays hidden from root search until at least one is added."
        values={settings.fileSearchScopes ?? []}
        onChange={(fileSearchScopes) => save({ fileSearchScopes })}
      />
    </div>
  )
}
