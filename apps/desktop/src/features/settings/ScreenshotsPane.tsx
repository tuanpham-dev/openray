import { useEffect, useState } from 'react'
import { Toggle } from './Toggle'
import { SegmentedControl } from './SegmentedControl'
import { StringListField } from './StringListField'
import { AutoPasteIcon, CameraIcon, ChevronDownIcon, FileIcon, GridColumnsIcon, TextIcon } from '../../components/icons'
import { updateSettings, type Settings } from '../../ipc/settings'
import { screenshotOcrStatus } from '../../ipc/screenshots'

const STORAGE_DURATION_OPTIONS: { value: Settings['screenshotStorageDuration']; label: string }[] = [
  { value: 'unlimited', label: 'Unlimited' },
  { value: '1', label: '1 Day' },
  { value: '7', label: '1 Week' },
  { value: '30', label: '1 Month' },
  { value: '90', label: '3 Months' },
  { value: '180', label: '6 Months' },
  { value: '365', label: '1 Year' },
]

type GridColumnValue = '3' | '4' | '5' | '6'

const GRID_COLUMN_OPTIONS: { value: GridColumnValue; label: string; icon: React.ReactNode }[] = [
  { value: '3', label: '3', icon: <GridColumnsIcon count={3} /> },
  { value: '4', label: '4', icon: <GridColumnsIcon count={4} /> },
  { value: '5', label: '5', icon: <GridColumnsIcon count={5} /> },
  { value: '6', label: '6', icon: <GridColumnsIcon count={6} /> },
]

const PASTE_FORMAT_OPTIONS: { value: Settings['screenshotPasteFormat']; label: string; icon: React.ReactNode }[] = [
  { value: 'auto', label: 'Auto', icon: <AutoPasteIcon /> },
  { value: 'image', label: 'Image', icon: <CameraIcon /> },
  { value: 'file', label: 'File', icon: <FileIcon /> },
  { value: 'path', label: 'Path', icon: <TextIcon /> },
]

interface ScreenshotsPrefsProps {
  settings: Settings
  onChange: (settings: Settings) => void
}

export function ScreenshotsPrefs({ settings, onChange }: ScreenshotsPrefsProps) {
  const [ocrEngine, setOcrEngine] = useState<string | null | 'loading'>('loading')

  useEffect(() => {
    void screenshotOcrStatus().then(setOcrEngine)
  }, [])

  const save = (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch }
    onChange(next)
    void updateSettings(next)
  }

  const ocrStatusLine =
    ocrEngine === 'loading'
      ? null
      : ocrEngine
        ? `Text search: ${ocrEngine}`
        : 'Install tesseract to enable text search.'

  return (
    <div className="openray-settings-form">
      <label className="openray-settings-form-label" htmlFor="screenshot-scopes-input">
        Search Scopes
      </label>
      <StringListField
        id="screenshot-scopes-input"
        placeholder="~/Pictures/Screenshots"
        hint="Folders scanned for screenshots and recordings"
        values={settings.screenshotSearchScopes ?? []}
        onChange={(screenshotSearchScopes) => save({ screenshotSearchScopes })}
      />

      <hr className="openray-settings-separator" />

      <label className="openray-settings-form-label" htmlFor="screenshot-video-extensions-input">
        Video Extensions
      </label>
      <StringListField
        id="screenshot-video-extensions-input"
        placeholder="mp4"
        hint="File extensions (no leading dot) shown as videos, not images"
        values={settings.screenshotVideoExtensions ?? []}
        onChange={(screenshotVideoExtensions) => save({ screenshotVideoExtensions })}
      />

      <hr className="openray-settings-separator" />

      <label className="openray-settings-form-label" htmlFor="screenshot-storage-duration-select">
        Storage Duration
      </label>
      <span className="openray-settings-control-group">
        <div className="openray-form-field">
          <select
            id="screenshot-storage-duration-select"
            value={settings.screenshotStorageDuration}
            onChange={(event) => save({ screenshotStorageDuration: event.target.value as Settings['screenshotStorageDuration'] })}
          >
            {STORAGE_DURATION_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <ChevronDownIcon size={13} className="openray-settings-select-chevron" />
        </div>
        <span className="openray-settings-control-hint">
          Screenshots older than this are moved to the trash once a day. Pinned screenshots are never removed.
        </span>
      </span>

      <hr className="openray-settings-separator" />

      <label className="openray-settings-form-label">Grid Columns</label>
      <SegmentedControl
        label="Grid Columns"
        options={GRID_COLUMN_OPTIONS}
        value={String(settings.screenshotGridColumns) as GridColumnValue}
        onChange={(value) => save({ screenshotGridColumns: Number(value) })}
      />

      <hr className="openray-settings-separator" />

      <label className="openray-settings-form-label">Default Paste Format</label>
      <div className="openray-settings-control-stack">
        <SegmentedControl
          label="Default Paste Format"
          options={PASTE_FORMAT_OPTIONS}
          value={settings.screenshotPasteFormat}
          onChange={(value) => save({ screenshotPasteFormat: value })}
        />
        <span className="openray-settings-control-hint">
          What Paste/Copy put on the clipboard — Auto offers the image, a file, and the path together
          so the app you paste into picks whatever it understands (e.g. an image editor gets pixels, a
          text editor gets the path). Image, File, and Path each force a single format. The grid's
          Actions menu can always override this per file.
        </span>
      </div>

      <hr className="openray-settings-separator" />

      <label className="openray-settings-form-label" htmlFor="screenshot-ocr-toggle">
        Search Screenshot Text
      </label>
      <span className="openray-settings-control-group">
        <Toggle
          id="screenshot-ocr-toggle"
          checked={settings.screenshotOcrEnabled}
          onChange={(checked) => save({ screenshotOcrEnabled: checked })}
        />
        <span className="openray-settings-control-hint">{ocrStatusLine}</span>
      </span>
    </div>
  )
}
