import { useState } from 'react'
import { Action, ActionPanel, Form, popToRoot, showHUD, showToast, Toast, useNavigation } from '@raycast/api'
import { refreshRootCommands } from '@openray/extras'
import { LANGUAGES } from '@openray/translate-core'
import { createTranslateCommand, updateTranslateCommand, type TranslateCommand } from './storage'

interface TranslateCommandFormProps {
  /** Present when editing an existing command; absent when creating. */
  command?: TranslateCommand
  /** Called after a successful save — lets a pushed edit form pop back to
   *  the list it came from instead of always returning to root search. */
  onSaved?: () => void
}

export function TranslateCommandForm({ command, onSaved }: TranslateCommandFormProps) {
  const [title, setTitle] = useState(command?.title ?? '')
  const [error, setError] = useState<string | null>(null)
  const { pop } = useNavigation()

  const submit = async (values: Record<string, unknown>) => {
    const trimmedTitle = title.trim()
    const sourceLang = typeof values.sourceLang === 'string' ? values.sourceLang : 'auto'
    const targetLang = typeof values.targetLang === 'string' ? values.targetLang : 'en'
    if (!trimmedTitle) {
      setError('Title is required.')
      return
    }
    setError(null)

    try {
      if (command) {
        await updateTranslateCommand(command.id, trimmedTitle, sourceLang, targetLang)
      } else {
        await createTranslateCommand(trimmedTitle, sourceLang, targetLang)
      }
      await refreshRootCommands()
      if (onSaved) {
        onSaved()
        pop()
      } else {
        await showHUD(command ? 'Translate Command Updated' : 'Translate Command Created')
        await popToRoot()
      }
    } catch (err) {
      await showToast({ style: Toast.Style.Failure, title: 'Failed to save translate command', message: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <Form
      navigationTitle={command ? 'Edit Translate Command' : 'Create Translate Command'}
      actions={
        <ActionPanel>
          <Action.SubmitForm title={command ? 'Save Command' : 'Create Command'} onSubmit={submit} />
          {onSaved && <Action title="Cancel" onAction={() => pop()} />}
        </ActionPanel>
      }
    >
      <Form.TextField id="title" title="Title" placeholder="To French" defaultValue={command?.title} onChange={setTitle} autoFocus />
      <Form.Dropdown id="sourceLang" title="Source Language" defaultValue={command?.sourceLang ?? 'auto'}>
        <Form.Dropdown.Item value="auto" title="Detect Language" />
        {LANGUAGES.map((lang) => (
          <Form.Dropdown.Item key={lang.code} value={lang.code} title={lang.name} />
        ))}
      </Form.Dropdown>
      <Form.Dropdown id="targetLang" title="Target Language" defaultValue={command?.targetLang ?? 'en'}>
        {LANGUAGES.map((lang) => (
          <Form.Dropdown.Item key={lang.code} value={lang.code} title={lang.name} />
        ))}
      </Form.Dropdown>
      {error && <Form.Description title="Error" text={error} />}
    </Form>
  )
}

export default function CreateTranslateCommand() {
  return <TranslateCommandForm />
}
