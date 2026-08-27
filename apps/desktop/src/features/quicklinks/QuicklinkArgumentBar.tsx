interface QuicklinkArgumentBarProps {
  title: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
}

export function QuicklinkArgumentBar({ title, value, onChange, placeholder = 'Enter argument…' }: QuicklinkArgumentBarProps) {
  return (
    <div className="openray-argument-bar">
      <span className="openray-argument-bar-label">{title}</span>
      <input autoFocus value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} spellCheck={false} />
    </div>
  )
}
