interface ToggleProps {
  id: string
  checked: boolean
  onChange: (checked: boolean) => void
}

export function Toggle({ id, checked, onChange }: ToggleProps) {
  return (
    <label className="openray-toggle" htmlFor={id}>
      <input id={id} type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span className="openray-toggle-track" />
    </label>
  )
}
