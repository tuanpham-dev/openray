import { useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { Toggle } from './Toggle'
import { SegmentedControl } from './SegmentedControl'
import { SparklesIcon, TextIcon } from '../../components/icons'
import { updateSettings, type Settings } from '../../ipc/settings'

interface BuiltinPrefsProps {
  settings: Settings
  onChange: (settings: Settings) => void
}

const MODE_OPTIONS: { value: Settings['snippetAutoExpandMode']; label: string; icon: React.ReactNode }[] = [
  { value: 'instant', label: 'Instant', icon: <SparklesIcon size={16} /> },
  { value: 'delimiter', label: 'After Delimiter', icon: <TextIcon size={16} /> },
]

/** Native "special type" preferences for the Snippets extension — the
 *  auto-expansion toggle and its trigger mode live in native `Settings`
 *  (not `extension_preference_values`) because the Rust `AutoExpander`
 *  service reads them directly, the same way `screenshots`/`clipboard`
 *  keep their native settings here. */
export function SnippetsPrefs({ settings, onChange }: BuiltinPrefsProps) {
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null)

  useEffect(() => {
    const unlisten = listen<string>('snippet-auto-expand-unavailable', (event) => {
      setUnavailableReason(event.payload || 'unknown')
    })
    return () => {
      void unlisten.then((fn) => fn())
    }
  }, [])

  const save = (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch }
    onChange(next)
    void updateSettings(next)
  }

  return (
    <div className="openray-settings-pane openray-settings-pane--form">
      {unavailableReason && (
        <p className="openray-settings-banner">
          OpenRay couldn't start snippet auto-expansion. On Wayland this feature isn't
          available at all — no app is allowed to watch or type keystrokes into another
          window (bind a keyword to a snippet and paste it from the palette instead). On
          macOS, grant OpenRay <strong>Input Monitoring</strong> and <strong>Accessibility</strong>{' '}
          in System Settings → Privacy &amp; Security, then toggle this off and on again.
        </p>
      )}

      <div className="openray-settings-form">
        <label className="openray-settings-form-label" htmlFor="snippet-auto-expand">
          Auto-Expand Snippets
        </label>
        <div className="openray-settings-control-stack">
          <Toggle
            id="snippet-auto-expand"
            checked={settings.snippetAutoExpand}
            onChange={(checked) => save({ snippetAutoExpand: checked })}
          />
          <span className="openray-settings-control-hint">
            Type a snippet's keyword in any app to replace it in place with the expanded text.
            Use distinctive keywords like <code>;sig</code> or <code>;addr</code> to avoid
            accidental triggers. Snippets that take an argument aren't auto-expanded (their
            keyword still works from the palette). A snippet using <code>{'{selection}'}</code>{' '}
            briefly copies your current selection while expanding.
          </span>
        </div>

        <hr className="openray-settings-separator" />

        <label className="openray-settings-form-label">Trigger</label>
        <div className="openray-settings-control-stack">
          <SegmentedControl
            label="Trigger"
            options={MODE_OPTIONS}
            value={settings.snippetAutoExpandMode}
            onChange={(value) => save({ snippetAutoExpandMode: value })}
          />
          <span className="openray-settings-control-hint">
            <strong>Instant</strong> expands the moment the keyword is fully typed.{' '}
            <strong>After Delimiter</strong> waits until you type a space, tab, or enter after
            the keyword (that delimiter is consumed).
          </span>
        </div>
      </div>
    </div>
  )
}
