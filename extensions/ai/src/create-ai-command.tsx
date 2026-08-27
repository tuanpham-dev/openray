import { useState } from 'react'
import { Form, ActionPanel, Action, useNavigation, showToast, Toast } from '@raycast/api'
import { BUILTIN_MODELS } from '@openray/ai-core'
import * as storage from './storage'

export default function CreateAiCommandCommand() {
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState('')
  const [creativity, setCreativity] = useState('medium')
  const [outputMode, setOutputMode] = useState('view')
  const { pop } = useNavigation()

  const submit = async () => {
    if (!name.trim() || !prompt.trim()) {
      await showToast({ style: Toast.Style.Failure, title: 'Name and prompt are required' })
      return
    }
    await storage.createCommand(name.trim(), prompt, model || undefined, creativity, outputMode)
    await showToast({ style: Toast.Style.Success, title: 'AI command created' })
    pop()
  }

  return (
    <Form
      navigationTitle="Create AI Command"
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Create" onSubmit={() => void submit()} />
        </ActionPanel>
      }
    >
      <Form.TextField id="name" title="Name" value={name} onChange={setName} placeholder="My Command" />
      <Form.TextArea id="prompt" title="Prompt" value={prompt} onChange={setPrompt} placeholder="Rewrite the following: {selection}" />
      <Form.Dropdown id="model" title="Model" value={model} onChange={setModel}>
        <Form.Dropdown.Item title="Default model" value="" />
        {BUILTIN_MODELS.map((m) => (
          <Form.Dropdown.Item key={m.id} title={m.label} value={m.id} />
        ))}
      </Form.Dropdown>
      <Form.Dropdown id="creativity" title="Creativity" value={creativity} onChange={setCreativity}>
        <Form.Dropdown.Item title="None" value="none" />
        <Form.Dropdown.Item title="Low" value="low" />
        <Form.Dropdown.Item title="Medium" value="medium" />
        <Form.Dropdown.Item title="High" value="high" />
      </Form.Dropdown>
      <Form.Dropdown id="outputMode" title="Output" value={outputMode} onChange={setOutputMode}>
        <Form.Dropdown.Item title="View Response" value="view" />
        <Form.Dropdown.Item title="Replace Selection" value="replace" />
      </Form.Dropdown>
      <Form.Description text="Use {selection}, {clipboard}, {argument}, or {webpage} in the prompt." />
    </Form>
  )
}
