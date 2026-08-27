import type { ReactNode } from 'react'

export interface SegmentedOption<T extends string> {
  value: T
  label: string
  icon: ReactNode
}

interface SegmentedControlProps<T extends string> {
  options: SegmentedOption<T>[]
  value: T
  onChange: (value: T) => void
  /** Accessible name for the group, e.g. "Theme". */
  label: string
}

/**
 * Raycast's icon-tile picker: each option shows an icon with its label
 * beneath, and only the *label* of the selected option carries a pill —
 * the icon itself stays unhighlighted.
 *
 * Rendered as a radiogroup rather than buttons so arrow keys and screen
 * readers treat the options as one control, the way the native <select>
 * this replaces did.
 */
export function SegmentedControl<T extends string>({ options, value, onChange, label }: SegmentedControlProps<T>) {
  return (
    <div className="openray-segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            className={`openray-segmented-option${active ? ' openray-segmented-option--active' : ''}`}
            onClick={() => onChange(option.value)}
          >
            <span className="openray-segmented-icon">{option.icon}</span>
            <span className="openray-segmented-label">{option.label}</span>
          </button>
        )
      })}
    </div>
  )
}
