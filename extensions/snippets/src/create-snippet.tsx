import { useState } from 'react'
import { Action, ActionPanel, Form, Icon, popToRoot, showHUD, showToast, Toast, useNavigation } from '@raycast/api'
import { refreshRootCommands } from '@openray/extras'
import { createSnippet, updateSnippet, type Snippet } from './storage'

interface SnippetFormProps {
  /** Present when editing an existing snippet; absent when creating. */
  snippet?: Snippet
  /** Called after a successful save — lets a pushed edit form pop back to
   *  the list it came from instead of always returning to root search. */
  onSaved?: () => void
}

export function SnippetForm({ snippet, onSaved }: SnippetFormProps) {
  const [name, setName] = useState(snippet?.name ?? '')
  const [keyword, setKeyword] = useState(snippet?.keyword ?? '')
  const [body, setBody] = useState(snippet?.body ?? '')
  const [error, setError] = useState<string | null>(null)
  const { pop } = useNavigation()

  const submit = async () => {
    const trimmedName = name.trim()
    const trimmedBody = body.trim()
    if (!trimmedName || !trimmedBody) {
      setError('Name and body are both required.')
      return
    }
    setError(null)
    const trimmedKeyword = keyword.trim() || undefined

    try {
      if (snippet) {
        await updateSnippet(snippet.id, trimmedName, trimmedKeyword, trimmedBody)
      } else {
        await createSnippet(trimmedName, trimmedKeyword, trimmedBody)
      }
      await refreshRootCommands()
      if (onSaved) {
        onSaved()
        pop()
      } else {
        await showHUD(snippet ? 'Snippet Updated' : 'Snippet Created')
        await popToRoot()
      }
    } catch (err) {
      await showToast({ style: Toast.Style.Failure, title: 'Failed to save snippet', message: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <Form
      navigationTitle={snippet ? 'Edit Snippet' : 'Create Snippet'}
      actions={
        <ActionPanel>
          <Action.SubmitForm title={snippet ? 'Save Snippet' : 'Create Snippet'} onSubmit={submit} />
          {onSaved && <Action title="Cancel" icon={Icon.XMarkCircle} onAction={() => pop()} />}
        </ActionPanel>
      }
    >
      <Form.TextField id="name" title="Name" placeholder="Signature" defaultValue={snippet?.name} onChange={setName} autoFocus />
      <Form.TextField
        id="keyword"
        title="Keyword"
        placeholder="Optional — searchable, and the auto-expand trigger"
        info="Searchable alongside the name. When snippet auto-expansion is enabled in Settings, typing this keyword in any app replaces it with the expanded text — use a distinctive keyword like ;sig."
        defaultValue={snippet?.keyword}
        onChange={setKeyword}
      />
      <Form.TextArea id="body" title="Snippet" placeholder="Best regards,\nYour Name" defaultValue={snippet?.body} onChange={setBody} />
      <Form.Description text="Use {argument} where the value you type should be inserted. Also supports {clipboard}, {selection}, {snippet name=&quot;...&quot;}, {date}, {uuid}, and {cursor} to mark where the caret lands." />
      {error && <Form.Description title="Error" text={error} />}
    </Form>
  )
}

export default function CreateSnippet() {
  return <SnippetForm />
}
