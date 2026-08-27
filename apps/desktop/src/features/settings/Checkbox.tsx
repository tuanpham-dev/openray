interface CheckboxProps {
  id: string
  checked: boolean
  onChange: (checked: boolean) => void
}

export function Checkbox({ id, checked, onChange }: CheckboxProps) {
  return (
    <label className="openray-checkbox" htmlFor={id}>
      <input id={id} type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span className="openray-checkbox-box">
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
