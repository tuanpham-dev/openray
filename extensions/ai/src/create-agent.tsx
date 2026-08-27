import { useState } from 'react'
import { Form, ActionPanel, Action, useNavigation, showToast, Toast } from '@raycast/api'
import { BUILTIN_MODELS } from '@openray/ai-core'
import * as storage from './storage'

export default function CreateAgentCommand() {
  const [name, setName] = useState('')
  const [instructions, setInstructions] = useState('')
  const [model, setModel] = useState('')
  const { pop } = useNavigation()

  const submit = async () => {
    if (!name.trim() || !instructions.trim()) {
      await showToast({ style: Toast.Style.Failure, title: 'Name and instructions are required' })
      return
    }
    await storage.createAgent(name.trim(), undefined, instructions.trim(), model || undefined)
    await showToast({ style: Toast.Style.Success, title: 'Agent created' })
    pop()
  }

  return (
    <Form
      navigationTitle="Create Agent"
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Create" onSubmit={() => void submit()} />
        </ActionPanel>
      }
    >
      <Form.TextField id="name" title="Name" value={name} onChange={setName} placeholder="Researcher" />
      <Form.TextArea id="instructions" title="Instructions" value={instructions} onChange={setInstructions} placeholder="Be thorough and cite sources." />
      <Form.Dropdown id="model" title="Model" value={model} onChange={setModel}>
        <Form.Dropdown.Item title="Default model" value="" />
        {BUILTIN_MODELS.map((m) => (
          <Form.Dropdown.Item key={m.id} title={m.label} value={m.id} />
        ))}
      </Form.Dropdown>
      <Form.Description text="A new 'New Chat with <Name>' row appears in root search once created." />
    </Form>
  )
}
