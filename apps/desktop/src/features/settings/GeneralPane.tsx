import { useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { HotkeyRecorder } from './HotkeyRecorder'
import { Toggle } from './Toggle'
import { SegmentedControl } from './SegmentedControl'
import { ChevronDownIcon, MoonIcon, SunIcon, SystemThemeIcon, WindowSizeIcon } from '../../components/icons'
import { updateSettings, updateHotkey, type Settings, type WindowSize } from '../../ipc/settings'
import type { ThemePreference } from '../../theme/ThemeProvider'

const THEME_OPTIONS = [
  { value: 'light' as const, label: 'Light', icon: <SunIcon /> },
  { value: 'dark' as const, label: 'Dark', icon: <MoonIcon /> },
  { value: 'system' as const, label: 'System', icon: <SystemThemeIcon /> },
]

const WINDOW_SIZE_OPTIONS = [
  { value: 'small' as const, label: 'Small', icon: <WindowSizeIcon scale="small" /> },
  { value: 'medium' as const, label: 'Medium', icon: <WindowSizeIcon scale="medium" /> },
  { value: 'large' as const, label: 'Large', icon: <WindowSizeIcon scale="large" /> },
]

const TEXT_SIZE_OPTIONS: { value: Settings['textSize']; label: string }[] = [
  { value: 'default', label: 'Default' },
  { value: 'large', label: 'Large' },
  { value: 'larger', label: 'Larger' },
]

const SHOW_ON_SCREEN_OPTIONS: { value: Settings['showOnScreen']; label: string }[] = [
  { value: 'cursor', label: 'Screen with Cursor' },
  { value: 'primary', label: 'Primary Screen' },
]

interface GeneralPaneProps {
  settings: Settings
  onChange: (settings: Settings) => void
}

export function GeneralPane({ settings, onChange }: GeneralPaneProps) {
  const [hotkeyUnavailable, setHotkeyUnavailable] = useState(false)

  useEffect(() => {
    const unlisten = listen('hotkey-unavailable', () => setHotkeyUnavailable(true))
    return () => {
      void unlisten.then((fn) => fn())
    }
  }, [])

  useEffect(() => {
    setHotkeyUnavailable(false)
  }, [settings.hotkey])

  const save = (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch }
    onChange(next)
    void updateSettings(next)
  }

  /**
   * Same as `save`, but coalesces the write. Dragging a 1-step slider
   * emits a change per pixel, and every persist serializes settings.json,
   * writes it to disk, and broadcasts a `settings-changed` event that both
   * windows re-render on. The control itself stays live because `onChange`
   * updates local state immediately; only the persist waits.
   */
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
    <div className="openray-settings-pane openray-settings-pane--form">
      {hotkeyUnavailable && (
        <p className="openray-settings-banner">
          OpenRay couldn't set up "{settings.hotkey}" as a global hotkey — it's likely already used
          by another app or your desktop (on Wayland, this can also mean the compositor's shortcut
          portal isn't available, or you declined its permission dialog). Try a different
          combination below, or open OpenRay by running <code>openray</code> again — from a terminal,
          an app launcher, or a keybinding your desktop environment lets you assign to that
          command.
        </p>
      )}

      <div className="openray-settings-form">
        <label className="openray-settings-form-label">Hotkey</label>
        <HotkeyRecorder
          value={settings.hotkey}
          onRecord={async (hotkey) => {
            await updateHotkey(hotkey)
            onChange({ ...settings, hotkey })
          }}
        />

        <label className="openray-settings-form-label" htmlFor="launch-at-login">
          Launch at Login
        </label>
        <Toggle
          id="launch-at-login"
          checked={settings.launchAtLogin}
          onChange={(checked) => save({ launchAtLogin: checked })}
        />

        <label className="openray-settings-form-label" htmlFor="show-tray-icon">
          Show Tray Icon
        </label>
        <Toggle id="show-tray-icon" checked={settings.showTrayIcon} onChange={(checked) => save({ showTrayIcon: checked })} />

        <hr className="openray-settings-separator" />

        <span className="openray-settings-form-label">Appearance</span>
        <SegmentedControl
          label="Appearance"
          options={THEME_OPTIONS}
          value={settings.theme}
          onChange={(theme: ThemePreference) => save({ theme })}
        />

        <span className="openray-settings-form-label">Window Size</span>
        <SegmentedControl
          label="Window Size"
          options={WINDOW_SIZE_OPTIONS}
          value={settings.windowSize}
          onChange={(windowSize: WindowSize) => save({ windowSize })}
        />

        <label className="openray-settings-form-label" htmlFor="text-size-select">
          Text Size
        </label>
        <div className="openray-form-field">
          <select
            id="text-size-select"
            value={settings.textSize}
            onChange={(event) => save({ textSize: event.target.value as Settings['textSize'] })}
          >
            {TEXT_SIZE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <ChevronDownIcon size={13} className="openray-settings-select-chevron" />
        </div>

        <label className="openray-settings-form-label" htmlFor="show-on-screen-select">
          Show on Screen
        </label>
        <div className="openray-form-field">
          <select
            id="show-on-screen-select"
            value={settings.showOnScreen}
            onChange={(event) => save({ showOnScreen: event.target.value as Settings['showOnScreen'] })}
          >
            {SHOW_ON_SCREEN_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <ChevronDownIcon size={13} className="openray-settings-select-chevron" />
        </div>

        <label className="openray-settings-form-label" htmlFor="opacity-range">
          Background Opacity
        </label>
        <div className="openray-settings-range">
          <input
            id="opacity-range"
            type="range"
            min={30}
            max={100}
            step={1}
            value={Math.round(settings.opacity * 100)}
            onChange={(event) => saveDebounced({ opacity: Number(event.target.value) / 100 })}
          />
          <span className="openray-settings-range-value">{Math.round(settings.opacity * 100)}%</span>
        </div>

        <label className="openray-settings-form-label" htmlFor="shadow-toggle">
          Window Shadow
        </label>
        <Toggle id="shadow-toggle" checked={settings.shadow} onChange={(checked) => save({ shadow: checked })} />

        <hr className="openray-settings-separator" />

        <label className="openray-settings-form-label" htmlFor="alt-jk-toggle">
          Vim Style Navigation
        </label>
        <span className="openray-settings-control-group">
          <Toggle
            id="alt-jk-toggle"
            checked={settings.altJkNavigation}
            onChange={(checked) => save({ altJkNavigation: checked })}
          />
          <span className="openray-settings-control-hint">Alt+J/K move through lists; Alt+H/L move across grids</span>
        </span>
      </div>

      <div className="openray-settings-bottom-spacer" />
    </div>
  )
}
