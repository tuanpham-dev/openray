import { Toggle } from './Toggle'
import { updateSettings, type Settings } from '../../ipc/settings'

interface NotesPrefsProps {
  settings: Settings
  onChange: (settings: Settings) => void
}

export function NotesPrefs({ settings, onChange }: NotesPrefsProps) {
  const save = (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch }
    onChange(next)
    void updateSettings(next)
  }

  return (
    <div className="openray-settings-form">
      <label className="openray-settings-form-label" htmlFor="notes-always-on-top-toggle">
        Always on Top
      </label>
      <span className="openray-settings-control-group">
        <Toggle
          id="notes-always-on-top-toggle"
          checked={settings.notesAlwaysOnTop}
          onChange={(checked) => save({ notesAlwaysOnTop: checked })}
        />
        <span className="openray-settings-control-hint">Keeps the notes window above other windows.</span>
      </span>
    </div>
  )
}
