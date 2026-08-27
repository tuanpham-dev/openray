import { ChevronDownIcon } from '../../components/icons'
import { updateSettings, type Settings } from '../../ipc/settings'

const POP_TO_ROOT_OPTIONS: { value: Settings['popToRootDelay']; label: string }[] = [
  { value: 'never', label: 'Never' },
  { value: 'immediately', label: 'Immediately' },
  { value: '10', label: 'After 10 seconds' },
  { value: '30', label: 'After 30 seconds' },
  { value: '60', label: 'After 1 minute' },
  { value: '90', label: 'After 90 seconds' },
  { value: '180', label: 'After 3 minutes' },
]

const SENSITIVITY_OPTIONS: { value: Settings['searchSensitivity']; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
]

interface AdvancedPaneProps {
  settings: Settings
  onChange: (settings: Settings) => void
}

export function AdvancedPane({ settings, onChange }: AdvancedPaneProps) {
  const save = (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch }
    onChange(next)
    void updateSettings(next)
  }

  return (
    <div className="openray-settings-pane openray-settings-pane--form">
      <div className="openray-settings-form">
        <label className="openray-settings-form-label" htmlFor="pop-to-root-select">
          Pop to Root Search
        </label>
        <div className="openray-form-field">
          <select
            id="pop-to-root-select"
            value={settings.popToRootDelay}
            onChange={(event) => save({ popToRootDelay: event.target.value as Settings['popToRootDelay'] })}
          >
            {POP_TO_ROOT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <ChevronDownIcon size={13} className="openray-settings-select-chevron" />
        </div>

        <label className="openray-settings-form-label" htmlFor="sensitivity-select">
          Root Search Sensitivity
        </label>
        <span className="openray-settings-control-group">
          <div className="openray-form-field">
            <select
              id="sensitivity-select"
              value={settings.searchSensitivity}
              onChange={(event) => save({ searchSensitivity: event.target.value as Settings['searchSensitivity'] })}
            >
              {SENSITIVITY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <ChevronDownIcon size={13} className="openray-settings-select-chevron" />
          </div>
          <span className="openray-settings-control-hint">Higher filters out weaker matches</span>
        </span>
      </div>
    </div>
  )
}
