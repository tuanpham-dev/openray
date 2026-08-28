import { Fragment, useEffect, useMemo, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { Checkbox } from './Checkbox'
import { ChevronDownIcon, FolderIcon } from '../../components/icons'
import {
  extensionPreferenceDefinitions,
  extensionPreferenceValues,
  setExtensionPreferenceValue,
  type PreferenceDefinition,
} from '../../ipc/extensions'

interface ExtensionPrefsFormProps {
  extensionId: string
  /** Render nothing instead of the empty-state message when there are no
   *  preferences — used where a native prefs section already covers the
   *  extension and an empty schema form would just be noise. */
  hideEmptyState?: boolean
  /** Fired once the definitions fetch resolves, so a parent that wants to
   *  hide its own "Preferences" heading when this form has nothing to show
   *  (and no native section covers the extension either) can find out —
   *  this component's own emptiness isn't known until after that fetch. */
  onEmptyChange?: (empty: boolean) => void
}

export function ExtensionPrefsForm({ extensionId, hideEmptyState, onEmptyChange }: ExtensionPrefsFormProps) {
  const [definitions, setDefinitions] = useState<PreferenceDefinition[]>([])
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void Promise.all([extensionPreferenceDefinitions(extensionId), extensionPreferenceValues(extensionId)]).then(
      ([defs, vals]) => {
        if (cancelled) return
        setDefinitions(defs)
        setValues(vals)
        setLoading(false)
        onEmptyChange?.(defs.length === 0)
      },
    )
    return () => {
      cancelled = true
    }
    // onEmptyChange is expected to be referentially stable (a setState
    // function) — including it would refire this fetch on every parent
    // render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extensionId])

  const grouped = useMemo(() => {
    const groups = new Map<string, PreferenceDefinition[]>()
    for (const def of definitions) {
      const key = def.commandName || ''
      const list = groups.get(key) ?? []
      list.push(def)
      groups.set(key, list)
    }
    return groups
  }, [definitions])

  const set = (name: string, value: unknown) => {
    setValues((current) => ({ ...current, [name]: value }))
    void setExtensionPreferenceValue(extensionId, name, value)
  }

  if (loading) {
    return <p className="openray-extension-prefs-empty">Loading preferences…</p>
  }

  if (definitions.length === 0) {
    if (hideEmptyState) return null
    return <p className="openray-extension-prefs-empty">This extension has no preferences.</p>
  }

  return (
    <div className="openray-extension-prefs">
      {[...grouped.entries()].map(([commandName, defs]) => (
        <div key={commandName || 'general'} className="openray-extension-prefs-group">
          <h4>{commandName || 'General'}</h4>
          {/* The same right-aligned label / stretched control grid every
              native pane uses (`GeneralPane`, `ScreenshotsPrefs`, …), rather
              than this form's old per-row flex with a rule under each row —
              a schema-driven preference should be indistinguishable from a
              hand-written one. */}
          <div className="openray-settings-form">
            {defs.map((def) => (
              // Falls back to the schema's own default so the form shows
              // what the extension will actually read (`getPreferenceValues`
              // applies the same default), not an empty "Select…".
              <PreferenceField
                key={`${commandName}:${def.name}`}
                definition={def}
                value={values[def.name] ?? def.defaultValue}
                onChange={(value) => set(def.name, value)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

interface PreferenceFieldProps {
  definition: PreferenceDefinition
  value: unknown
  onChange: (value: unknown) => void
}

function PreferenceField({ definition, value, onChange }: PreferenceFieldProps) {
  const label = definition.title ?? definition.label ?? definition.name
  const fieldId = `pref-${definition.extensionId}-${definition.commandName}-${definition.name}`
  // With a hint under the control, the label reads against the control
  // itself rather than the middle of the pair — and a checkbox's box is
  // half a text field's height, so it needs its own smaller offset.
  const labelAlignment = !definition.description
    ? ''
    : definition.preferenceType === 'checkbox'
      ? ' openray-settings-form-label--top-compact'
      : ' openray-settings-form-label--top'

  // A Fragment, not a wrapper element: label and control are two direct
  // children of the grid, so every control lines up in the same column
  // regardless of label length.
  return (
    <Fragment>
      <label htmlFor={fieldId} className={`openray-settings-form-label${labelAlignment}`}>
        {label}
        {definition.required && <span className="openray-extension-pref-required">*</span>}
      </label>
      <div className="openray-settings-control-stack">
        <PreferenceInput fieldId={fieldId} definition={definition} value={value} onChange={onChange} />
        {definition.description && <span className="openray-settings-control-hint">{definition.description}</span>}
      </div>
    </Fragment>
  )
}

function PreferenceInput({ fieldId, definition, value, onChange }: PreferenceFieldProps & { fieldId: string }) {
  const text = typeof value === 'string' ? value : ''

  switch (definition.preferenceType) {
    case 'checkbox':
      return <Checkbox id={fieldId} checked={Boolean(value ?? false)} onChange={onChange} />
    case 'dropdown':
    case 'appPicker':
      return (
        <div className="openray-form-field">
          <select id={fieldId} value={text} onChange={(event) => onChange(event.target.value)}>
            <option value="" disabled>
              Select…
            </option>
            {(definition.data ?? []).map((option) => (
              <option key={option.value} value={option.value}>
                {option.title}
              </option>
            ))}
          </select>
          <ChevronDownIcon size={13} className="openray-settings-select-chevron" />
        </div>
      )
    case 'password':
      return (
        <input
          id={fieldId}
          type="password"
          className="openray-settings-text-input"
          placeholder={definition.placeholder ?? undefined}
          value={text}
          onChange={(event) => onChange(event.target.value)}
        />
      )
    // A path preference gets the OS chooser alongside the field — typing
    // stays available, since the dialog can't express a `~`-relative path.
    case 'file':
    case 'directory':
      return (
        <PathPreferenceInput
          fieldId={fieldId}
          directory={definition.preferenceType === 'directory'}
          placeholder={definition.placeholder ?? undefined}
          value={text}
          onChange={onChange}
        />
      )
    case 'textfield':
    default:
      return (
        <input
          id={fieldId}
          type="text"
          className="openray-settings-text-input"
          placeholder={definition.placeholder ?? undefined}
          value={text}
          onChange={(event) => onChange(event.target.value)}
        />
      )
  }
}

function PathPreferenceInput({
  fieldId,
  directory,
  placeholder,
  value,
  onChange,
}: {
  fieldId: string
  directory: boolean
  placeholder?: string
  value: string
  onChange: (value: unknown) => void
}) {
  const browse = async () => {
    const picked = await open({ directory, multiple: false, title: directory ? 'Choose Folder' : 'Choose File' })
    if (typeof picked === 'string') onChange(picked)
  }

  return (
    <div className="openray-settings-path-field">
      <input
        id={fieldId}
        type="text"
        className="openray-settings-text-input"
        placeholder={placeholder}
        value={value}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
      />
      <button type="button" className="openray-settings-browse-button" onClick={() => void browse()}>
        <FolderIcon size={14} />
        Choose…
      </button>
    </div>
  )
}
