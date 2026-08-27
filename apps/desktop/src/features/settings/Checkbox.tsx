import { useEffect, useRef } from 'react'

interface CheckboxProps {
  id: string
  checked: boolean
  onChange: (checked: boolean) => void
  /** Renders the "some but not all children" state. Set through a ref
   *  because `indeterminate` is a DOM property with no HTML attribute, so
   *  React can't set it declaratively. Purely visual — `checked` still
   *  decides what a click does. */
  indeterminate?: boolean
  disabled?: boolean
}

export function Checkbox({ id, checked, onChange, indeterminate = false, disabled = false }: CheckboxProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = indeterminate
  }, [indeterminate])

  return (
    <label className="openray-checkbox" htmlFor={id}>
      <input
        ref={inputRef}
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="openray-checkbox-box">
        {indeterminate && !checked && <span className="openray-checkbox-dash" />}
        {checked && (
          <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
            <path
              d="M1 4L3.5 6.5L9 1"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </span>
    </label>
  )
}
