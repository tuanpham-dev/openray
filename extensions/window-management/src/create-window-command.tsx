import { useState } from 'react'
import { Action, ActionPanel, Form, popToRoot, showHUD, showToast, Toast, useNavigation } from '@raycast/api'
import { refreshRootCommands } from '@openray/extras'
import { createWindowCommand, updateWindowCommand, type CustomUnit, type WindowCommand } from './storage'

interface WindowCommandFormProps {
  /** Present when editing an existing command; absent when creating. */
  command?: WindowCommand
  /** Called after a successful save — lets a pushed edit form pop back to
   *  the list it came from instead of always returning to root search. */
  onSaved?: () => void
}

/** `""` parses to `null` (the "leave blank to center" affordance); any
 * other non-numeric input is rejected by the caller before this runs. */
function parseOptionalNumber(text: string): number | null {
  const trimmed = text.trim()
  return trimmed === '' ? null : Number(trimmed)
}

export function WindowCommandForm({ command, onSaved }: WindowCommandFormProps) {
  const [title, setTitle] = useState(command?.title ?? '')
  const [unit, setUnit] = useState<CustomUnit>(command?.unit ?? 'percent')
  const [x, setX] = useState(command?.x != null ? String(command.x) : '')
  const [y, setY] = useState(command?.y != null ? String(command.y) : '')
  const [width, setWidth] = useState(command?.width != null ? String(command.width) : '')
  const [height, setHeight] = useState(command?.height != null ? String(command.height) : '')
  const [error, setError] = useState<string | null>(null)
  const { pop } = useNavigation()

  const submit = async () => {
    const trimmedTitle = title.trim()
    const parsedWidth = Number(width.trim())
    const parsedHeight = Number(height.trim())
    const parsedX = parseOptionalNumber(x)
    const parsedY = parseOptionalNumber(y)
    if (!trimmedTitle) {
      setError('Title is required.')
      return
    }
    if (width.trim() === '' || Number.isNaN(parsedWidth) || height.trim() === '' || Number.isNaN(parsedHeight)) {
      setError('Width and height must be numbers.')
      return
    }
    if ((x.trim() !== '' && Number.isNaN(parsedX)) || (y.trim() !== '' && Number.isNaN(parsedY))) {
      setError('X and Y must be numbers, or left blank to center.')
      return
    }
    setError(null)

    try {
      if (command) {
        await updateWindowCommand(command.id, trimmedTitle, unit, parsedX, parsedY, parsedWidth, parsedHeight)
      } else {
        await createWindowCommand(trimmedTitle, unit, parsedX, parsedY, parsedWidth, parsedHeight)
      }
      await refreshRootCommands()
      if (onSaved) {
        onSaved()
        pop()
      } else {
        await showHUD(command ? 'Window Command Updated' : 'Window Command Created')
        await popToRoot()
      }
    } catch (err) {
      await showToast({ style: Toast.Style.Failure, title: 'Failed to save window command', message: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <Form
      navigationTitle={command ? 'Edit Window Command' : 'Create Window Command'}
      actions={
        <ActionPanel>
          <Action.SubmitForm title={command ? 'Save Window Command' : 'Create Window Command'} onSubmit={submit} />
          {onSaved && <Action title="Cancel" onAction={() => pop()} />}
        </ActionPanel>
      }
    >
      {/* defaultValue (uncontrolled), not value — see create-quicklink.tsx
          for why: the host tree renderer only reads a field's initial
          display from defaultValue, tracking further keystrokes itself. */}
      <Form.TextField id="title" title="Title" placeholder="Left Two Thirds" defaultValue={command?.title} onChange={setTitle} autoFocus />
      <Form.Dropdown id="unit" title="Unit" defaultValue={command?.unit ?? 'percent'} onChange={(value) => setUnit(value as CustomUnit)}>
        <Form.Dropdown.Item value="percent" title="Percent of screen" />
        <Form.Dropdown.Item value="pixels" title="Pixels" />
      </Form.Dropdown>
      <Form.TextField id="width" title="Width" placeholder={unit === 'percent' ? '66' : '1280'} defaultValue={command?.width != null ? String(command.width) : undefined} onChange={setWidth} />
      <Form.TextField id="height" title="Height" placeholder={unit === 'percent' ? '100' : '900'} defaultValue={command?.height != null ? String(command.height) : undefined} onChange={setHeight} />
      <Form.TextField id="x" title="X (blank to center)" placeholder="0" defaultValue={command?.x != null ? String(command.x) : undefined} onChange={setX} />
      <Form.TextField id="y" title="Y (blank to center)" placeholder="0" defaultValue={command?.y != null ? String(command.y) : undefined} onChange={setY} />
      <Form.Description text="Width/height/x/y are either a percent of the screen's work area or an absolute pixel count, depending on Unit. Leave X or Y blank to center that axis." />
      {error && <Form.Description title="Error" text={error} />}
    </Form>
  )
}

export default function CreateWindowCommand() {
  return <WindowCommandForm />
}
