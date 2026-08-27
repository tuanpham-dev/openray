import type { ComponentType } from 'react'
import { StringListField } from './StringListField'
import { updateSettings, type Settings } from '../../ipc/settings'
import { WindowManagementPrefs } from './WindowPane'
import { ScreenshotsPrefs } from './ScreenshotsPane'
import { TranslatePrefs } from './TranslatePane'
import { NotesPrefs } from './NotesPane'
import { AiPrefs } from './AiPane'
import { ClipboardPrefs } from './ClipboardPane'
import { FileSearchPrefs } from './FileSearchPane'

interface BuiltinPrefsProps {
  settings: Settings
  onChange: (settings: Settings) => void
}

/** Script Directories, moved here from `GeneralPane` — it was always the
 *  `script-commands` extension's own setting, not a general one. */
function ScriptCommandsPrefs({ settings, onChange }: BuiltinPrefsProps) {
  const save = (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch }
    onChange(next)
    void updateSettings(next)
  }

  return (
    <div className="openray-settings-form">
      <label className="openray-settings-form-label" htmlFor="script-directory-input">
        Script Directories
      </label>
      <StringListField
        id="script-directory-input"
        placeholder="~/scripts"
        hint={
          <>
            Folders scanned for scripts with Raycast-compatible <code>@raycast.*</code> headers —{' '}
            <code>@openray.*</code> is accepted for the same fields
          </>
        }
        values={settings.scriptDirectories ?? []}
        onChange={(scriptDirectories) => save({ scriptDirectories })}
      />
    </div>
  )
}

/** Built-in extension ids that have native "special type" preferences —
 *  values stay in native `Settings`, not `extension_preference_values`,
 *  preserving `host.*.getSettings` and sync-exclusion semantics. */
export const BUILTIN_PREFS: Record<string, ComponentType<BuiltinPrefsProps>> = {
  'window-management': WindowManagementPrefs,
  screenshots: ScreenshotsPrefs,
  translate: TranslatePrefs,
  notes: NotesPrefs,
  ai: AiPrefs,
  'script-commands': ScriptCommandsPrefs,
  'clipboard-history': ClipboardPrefs,
  'file-search': FileSearchPrefs,
}
