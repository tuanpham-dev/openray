import { useEffect, useRef } from 'react'
import { Toggle } from './Toggle'
import { updateSettings, type Settings } from '../../ipc/settings'

interface WindowManagementPrefsProps {
  settings: Settings
  onChange: (settings: Settings) => void
}

export function WindowManagementPrefs({ settings, onChange }: WindowManagementPrefsProps) {
  const save = (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch }
    onChange(next)
    void updateSettings(next)
  }

  // Same debounce as the opacity slider in GeneralPane — dragging emits a
  // change per pixel, and every persist serializes settings.json to disk.
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

  return (
    <div className="openray-settings-form">
      <label className="openray-settings-form-label" htmlFor="window-gap-range">
        Window Gap
      </label>
      <div className="openray-settings-range">
        <input
          id="window-gap-range"
          type="range"
          min={0}
          max={64}
          step={1}
          value={settings.windowGap}
          onChange={(event) => saveDebounced({ windowGap: Number(event.target.value) })}
        />
        <span className="openray-settings-range-value">{settings.windowGap}px</span>
      </div>

      <label className="openray-settings-form-label" htmlFor="half-cycling-toggle">
        Cycle Half Sizes
      </label>
      <span className="openray-settings-control-group">
        <Toggle
          id="half-cycling-toggle"
          checked={settings.halfCycling}
          onChange={(checked) => save({ halfCycling: checked })}
        />
        <span className="openray-settings-control-hint">
          Repeatedly pressing the same half command cycles its size through ½ → ⅔ → ⅓
        </span>
      </span>
    </div>
  )
}
