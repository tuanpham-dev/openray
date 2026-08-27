import { useEffect, useRef, useState } from 'react'
import { ChevronDownIcon } from '../../components/icons'
import { updateSettings, type Settings } from '../../ipc/settings'

const MIN_ENTRIES = 100
const MAX_ENTRIES = 10000
const MIN_IMAGE_MB = 4
const MAX_IMAGE_MB = 256

const RETENTION_OPTIONS: { value: Settings['clipboardRetentionDays']; label: string }[] = [
  { value: 'never', label: 'Never' },
  { value: '1', label: '1 Day' },
  { value: '7', label: '1 Week' },
  { value: '30', label: '1 Month' },
  { value: '90', label: '3 Months' },
  { value: '180', label: '6 Months' },
  { value: '365', label: '1 Year' },
]

interface ClipboardPrefsProps {
  settings: Settings
  onChange: (settings: Settings) => void
}

export function ClipboardPrefs({ settings, onChange }: ClipboardPrefsProps) {
  const [entriesInput, setEntriesInput] = useState(String(settings.clipboardMaxEntries))
  const [imageMbInput, setImageMbInput] = useState(String(settings.clipboardMaxImageMb))

  useEffect(() => setEntriesInput(String(settings.clipboardMaxEntries)), [settings.clipboardMaxEntries])
  useEffect(() => setImageMbInput(String(settings.clipboardMaxImageMb)), [settings.clipboardMaxImageMb])

  const save = (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch }
    onChange(next)
    void updateSettings(next)
  }

  // Same debounce as the opacity slider in GeneralPane — every persist
  // serializes settings.json to disk and broadcasts settings-changed.
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveDebounced = (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch }
    onChange(next)
    if (persistTimer.current) clearTimeout(persistTimer.current)
    persistTimer.current = setTimeout(() => {
      void updateSettings(next)
    }, 120)
  }

  useEffect(() => {
    return () => {
      if (persistTimer.current) clearTimeout(persistTimer.current)
    }
  }, [])

  const clamp = (value: string, min: number, max: number, fallback: number): number => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return fallback
    return Math.min(max, Math.max(min, Math.round(parsed)))
  }

  return (
    <div className="openray-settings-form">
      <label className="openray-settings-form-label" htmlFor="clipboard-retention-select">
        Retention
      </label>
      <span className="openray-settings-control-group">
        <div className="openray-form-field">
          <select
            id="clipboard-retention-select"
            value={settings.clipboardRetentionDays}
            onChange={(event) => save({ clipboardRetentionDays: event.target.value as Settings['clipboardRetentionDays'] })}
          >
            {RETENTION_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <ChevronDownIcon size={13} className="openray-settings-select-chevron" />
        </div>
        <span className="openray-settings-control-hint">Entries older than this are deleted, alongside the Maximum Entries cap below</span>
      </span>

      <hr className="openray-settings-separator" />

      <label className="openray-settings-form-label" htmlFor="clipboard-max-entries-input">
        Maximum Entries
      </label>
      <span className="openray-settings-control-group">
        <input
          id="clipboard-max-entries-input"
          type="number"
          min={MIN_ENTRIES}
          max={MAX_ENTRIES}
          value={entriesInput}
          onChange={(event) => setEntriesInput(event.target.value)}
          onBlur={() => {
            const clipboardMaxEntries = clamp(entriesInput, MIN_ENTRIES, MAX_ENTRIES, settings.clipboardMaxEntries)
            setEntriesInput(String(clipboardMaxEntries))
            saveDebounced({ clipboardMaxEntries })
          }}
        />
        <span className="openray-settings-control-hint">Older entries are deleted past this limit</span>
      </span>

      <label className="openray-settings-form-label" htmlFor="clipboard-max-image-mb-input">
        Maximum Image Size
      </label>
      <span className="openray-settings-control-group">
        <input
          id="clipboard-max-image-mb-input"
          type="number"
          min={MIN_IMAGE_MB}
          max={MAX_IMAGE_MB}
          value={imageMbInput}
          onChange={(event) => setImageMbInput(event.target.value)}
          onBlur={() => {
            const clipboardMaxImageMb = clamp(imageMbInput, MIN_IMAGE_MB, MAX_IMAGE_MB, settings.clipboardMaxImageMb)
            setImageMbInput(String(clipboardMaxImageMb))
            saveDebounced({ clipboardMaxImageMb })
          }}
        />
        <span className="openray-settings-control-hint">MB — larger images are skipped</span>
      </span>
    </div>
  )
}
