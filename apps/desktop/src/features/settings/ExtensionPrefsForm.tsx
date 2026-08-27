import { useEffect, useMemo, useState } from 'react'
import { Checkbox } from './Checkbox'
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
          {defs.map((def) => (
            <PreferenceField key={`${commandName}:${def.name}`} definition={def} value={values[def.name]} onChange={(value) => set(def.name, value)} />
          ))}
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

  return (
    <div className="openray-settings-row openray-extension-pref-row">
      <label htmlFor={fieldId} className="openray-settings-row-label">
        {label}
        {definition.required && <span className="openray-extension-pref-required">*</span>}
      </label>
      <PreferenceInput fieldId={fieldId} definition={definition} value={value} onChange={onChange} />
    </div>
  )
}

function PreferenceInput({ fieldId, definition, value, onChange }: PreferenceFieldProps & { fieldId: string }) {
  switch (definition.preferenceType) {
    case 'checkbox':
      return <Checkbox id={fieldId} checked={Boolean(value ?? false)} onChange={onChange} />
    case 'dropdown':
    case 'appPicker':
      return (
        <select id={fieldId} value={typeof value === 'string' ? value : ''} onChange={(event) => onChange(event.target.value)}>
          <option value="" disabled>
            Select…
          </option>
          {(definition.data ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.title}
            </option>
          ))}
        </select>
      )
    case 'password':
      return (
        <input
          id={fieldId}
          type="password"
          placeholder={definition.placeholder ?? undefined}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(event.target.value)}
        />
      )
    case 'file':
    case 'directory':
    case 'textfield':
    default:
      return (
        <input
          id={fieldId}
          type="text"
          placeholder={definition.placeholder ?? undefined}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(event.target.value)}
        />
      )
  }
}
