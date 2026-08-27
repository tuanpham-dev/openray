import { useState } from 'react'
import { LANGUAGES } from '@openray/translate-core'
import { Toggle } from './Toggle'
import { SegmentedControl } from './SegmentedControl'
import { ChevronDownIcon, ClipboardIcon, CopyIcon } from '../../components/icons'
import { clearTranslateHistory, updateSettings, type Settings } from '../../ipc/settings'

const PRIMARY_ACTION_OPTIONS: { value: Settings['translatePrimaryAction']; label: string; icon: React.ReactNode }[] = [
  { value: 'copy', label: 'Copy', icon: <CopyIcon size={16} /> },
  { value: 'paste', label: 'Paste', icon: <ClipboardIcon size={16} /> },
]

interface TranslatePrefsProps {
  settings: Settings
  onChange: (settings: Settings) => void
}

export function TranslatePrefs({ settings, onChange }: TranslatePrefsProps) {
  const [clearing, setClearing] = useState(false)

  const save = (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch }
    onChange(next)
    void updateSettings(next)
  }

  return (
    <div className="openray-settings-form">
      <label className="openray-settings-form-label">Primary Action</label>
      <div className="openray-settings-control-stack">
        <SegmentedControl
          label="Primary Action"
          options={PRIMARY_ACTION_OPTIONS}
          value={settings.translatePrimaryAction}
          onChange={(value) => save({ translatePrimaryAction: value })}
        />
        <span className="openray-settings-control-hint">What ↵ does with the translated text in the Translate view.</span>
      </div>

      <hr className="openray-settings-separator" />

      <label className="openray-settings-form-label" htmlFor="translate-default-source">
        Default Source Language
      </label>
      <div className="openray-form-field">
        <select
          id="translate-default-source"
          value={settings.translateSourceLanguage}
          onChange={(event) => save({ translateSourceLanguage: event.target.value })}
        >
          <option value="auto">Detect Language</option>
          {LANGUAGES.map((lang) => (
            <option key={lang.code} value={lang.code}>
              {lang.name}
            </option>
          ))}
        </select>
        <ChevronDownIcon size={13} className="openray-settings-select-chevron" />
      </div>

      <label className="openray-settings-form-label" htmlFor="translate-default-target">
        Default Target Language
      </label>
      <div className="openray-form-field">
        <select
          id="translate-default-target"
          value={settings.translateTargetLanguage}
          onChange={(event) => save({ translateTargetLanguage: event.target.value })}
        >
          {LANGUAGES.map((lang) => (
            <option key={lang.code} value={lang.code}>
              {lang.name}
            </option>
          ))}
        </select>
        <ChevronDownIcon size={13} className="openray-settings-select-chevron" />
      </div>

      <hr className="openray-settings-separator" />

      <label className="openray-settings-form-label" htmlFor="translate-history-toggle">
        Save Translation History
      </label>
      <span className="openray-settings-control-group">
        <Toggle
          id="translate-history-toggle"
          checked={settings.translateHistoryEnabled}
          onChange={(checked) => save({ translateHistoryEnabled: checked })}
        />
        <button
          type="button"
          className="openray-form-button"
          disabled={clearing}
          onClick={() => {
            setClearing(true)
            void clearTranslateHistory().finally(() => setClearing(false))
          }}
        >
          Clear History
        </button>
      </span>
    </div>
  )
}
