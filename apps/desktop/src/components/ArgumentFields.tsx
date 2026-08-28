import { forwardRef, useImperativeHandle, useRef, type KeyboardEvent } from 'react'
import type { CommandArgument } from './types'
import { useAutoWidth } from './useAutoWidth'

/**
 * A command's arguments, rendered inline in the search bar.
 *
 * This is how Raycast does it: selecting a command that declares arguments
 * puts its fields right there in root search, immediately after the query
 * text, and a single ↵ runs the command. Each field is sized to its own
 * content so the row reads as `query [field] [field]` rather than leaving a
 * gulf between them. OpenRay used to push a separate full-screen prompt
 * instead, which cost an extra ↵ and — being a text field above an empty
 * area — read as a search box that had found nothing.
 */

export interface ArgumentFieldsHandle {
  /** Focuses a specific field (the first empty required one, on submit). */
  focus: (index: number) => void
}

interface ArgumentFieldsProps {
  args: CommandArgument[]
  values: Record<string, string>
  onChange: (name: string, value: string) => void
  /** Enter anywhere in the fields runs the command. */
  onSubmit: () => void
  /** Moving left off the first field hands focus back to the query. */
  onExit: () => void
}

interface FieldProps {
  argument: CommandArgument
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  onMove: (delta: number) => void
  register: (element: HTMLInputElement | HTMLSelectElement | null) => void
}

/**
 * Its own component so it can measure its own text — hooks can't run inside
 * the map that renders the list.
 */
function ArgumentField({ argument, value, onChange, onSubmit, onMove, register }: FieldProps) {
  const placeholder = argument.placeholder ?? argument.name
  const [measureRef, width] = useAutoWidth<HTMLInputElement>(value, { min: 56, max: 320, placeholder })

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // Every key handled here must also stop propagating: the palette has a
    // window-level keydown listener that activates the selected row on
    // Enter, so letting it through ran the command twice — two identical
    // notes, a millisecond apart.
    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      onSubmit()
      return
    }
    if (event.key === 'Tab') {
      // Tab is the documented way to move between argument fields; handled
      // here so focus stays inside the bar rather than escaping to whatever
      // the browser considers next.
      event.preventDefault()
      event.stopPropagation()
      onMove(event.shiftKey ? -1 : 1)
      return
    }
    const input = event.currentTarget as HTMLInputElement
    // Only at the very edge, so arrowing *within* a value still works.
    if (event.key === 'ArrowLeft' && input.selectionStart === 0) {
      event.preventDefault()
      event.stopPropagation()
      onMove(-1)
      return
    }
    if (event.key === 'ArrowRight' && input.selectionStart === value.length) {
      event.preventDefault()
      event.stopPropagation()
      onMove(1)
    }
    // Up/down are deliberately left alone: they still move the selection in
    // the list below, so you can change command without leaving the field.
  }

  if (argument.type === 'dropdown' && argument.data?.length) {
    return (
      <select
        ref={register}
        className="openray-argument-field"
        value={value}
        onKeyDown={onKeyDown}
        onChange={(event) => onChange(event.target.value)}
        aria-label={placeholder}
      >
        {/* An optional dropdown can legitimately be left unset. */}
        {!argument.required && <option value="">{placeholder}</option>}
        {argument.data.map((option) => (
          <option key={option.value} value={option.value}>
            {option.title}
          </option>
        ))}
      </select>
    )
  }

  return (
    <input
      ref={(element) => {
        measureRef.current = element
        register(element)
      }}
      className="openray-argument-field"
      style={{ width }}
      type={argument.type === 'password' ? 'password' : 'text'}
      value={value}
      onKeyDown={onKeyDown}
      onChange={(event) => onChange(event.target.value)}
      // The manifest's own placeholder names the field ("Note text"), which
      // is the only label these get.
      placeholder={placeholder}
      spellCheck={false}
      data-required={argument.required ? 'true' : undefined}
    />
  )
}

export const ArgumentFields = forwardRef<ArgumentFieldsHandle, ArgumentFieldsProps>(function ArgumentFields(
  { args, values, onChange, onSubmit, onExit },
  ref,
) {
  const fields = useRef<(HTMLInputElement | HTMLSelectElement | null)[]>([])

  useImperativeHandle(ref, () => ({
    focus: (index: number) => fields.current[index]?.focus(),
  }))

  const move = (from: number, delta: number) => {
    const next = from + delta
    if (next < 0) {
      onExit()
      return
    }
    fields.current[Math.min(next, args.length - 1)]?.focus()
  }

  return (
    <div className="openray-argument-fields">
      {args.map((argument, index) => (
        <ArgumentField
          key={argument.name}
          argument={argument}
          value={values[argument.name] ?? ''}
          onChange={(value) => onChange(argument.name, value)}
          onSubmit={onSubmit}
          onMove={(delta) => move(index, delta)}
          register={(element) => {
            fields.current[index] = element
          }}
        />
      ))}
    </div>
  )
})
