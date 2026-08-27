import { useState } from 'react'
import { Action, ActionPanel, Form, popToRoot, showHUD, showToast, Toast, useNavigation } from '@raycast/api'
import { refreshRootCommands } from '@openray/extras'
import { createQuicklink, updateQuicklink, type Quicklink } from './storage'

interface QuicklinkFormProps {
  /** Present when editing an existing quicklink; absent when creating. */
  quicklink?: Quicklink
  /** Called after a successful save — lets a pushed edit form pop back to
   *  the list it came from instead of always returning to root search. */
  onSaved?: () => void
}

export function QuicklinkForm({ quicklink, onSaved }: QuicklinkFormProps) {
  const [title, setTitle] = useState(quicklink?.title ?? '')
  const [urlTemplate, setUrlTemplate] = useState(quicklink?.urlTemplate ?? '')
  const [error, setError] = useState<string | null>(null)
  const { pop } = useNavigation()

  const submit = async () => {
    const trimmedTitle = title.trim()
    const trimmedUrl = urlTemplate.trim()
    if (!trimmedTitle || !trimmedUrl) {
      setError('Title and URL/Path are both required.')
      return
    }
    setError(null)

    try {
      if (quicklink) {
        await updateQuicklink(quicklink.id, trimmedTitle, trimmedUrl)
      } else {
        await createQuicklink(trimmedTitle, trimmedUrl)
      }
      await refreshRootCommands()
      if (onSaved) {
        onSaved()
        pop()
      } else {
        await showHUD(quicklink ? 'Quicklink Updated' : 'Quicklink Created')
        await popToRoot()
      }
    } catch (err) {
      await showToast({ style: Toast.Style.Failure, title: 'Failed to save quicklink', message: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <Form
      navigationTitle={quicklink ? 'Edit Quicklink' : 'Create Quicklink'}
      actions={
        <ActionPanel>
          <Action.SubmitForm title={quicklink ? 'Save Quicklink' : 'Create Quicklink'} onSubmit={submit} />
          {onSaved && <Action title="Cancel" onAction={() => pop()} />}
        </ActionPanel>
      }
    >
      {/* defaultValue (uncontrolled), not value: the host tree renderer
          only reads defaultValue for a field's *initial* display, tracking
          further keystrokes in its own local state for zero-latency typing
          (no extension round trip per character) — a `value` prop is never
          read back for display, only `onChange`, which still fires here to
          keep this component's own state in sync for `submit()` to read. */}
      <Form.TextField id="title" title="Title" placeholder="GitHub" defaultValue={quicklink?.title} onChange={setTitle} autoFocus />
      <Form.TextField
        id="urlTemplate"
        title="URL or Path"
        placeholder="https://github.com/{query}"
        defaultValue={quicklink?.urlTemplate}
        onChange={setUrlTemplate}
      />
      <Form.Description text="Use {query} or {argument} where the value you type should be inserted. Also supports {clipboard}, {selection}, {date}, and {uuid}." />
      {error && <Form.Description title="Error" text={error} />}
    </Form>
  )
}

export default function CreateQuicklink() {
  return <QuicklinkForm />
}
