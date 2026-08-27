import { useEffect, useState } from 'react'
import { List, Form, ActionPanel, Action, useNavigation, showToast, Toast } from '@raycast/api'
import * as storage from './storage'
import type { ProviderKeyRecord } from './storage'

const PROVIDERS: { id: string; label: string; needsKey: boolean }[] = [
  { id: 'anthropic', label: 'Anthropic', needsKey: true },
  { id: 'openai', label: 'OpenAI', needsKey: true },
  { id: 'gemini', label: 'Google (Gemini)', needsKey: true },
  { id: 'ollama', label: 'Ollama', needsKey: false },
]

function ProviderKeyForm({ providerId, label, needsKey, onSaved }: { providerId: string; label: string; needsKey: boolean; onSaved: () => void }) {
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(providerId === 'ollama' ? 'http://localhost:11434/v1' : '')
  const { pop } = useNavigation()

  const submit = async () => {
    if (needsKey && !apiKey.trim()) {
      await showToast({ style: Toast.Style.Failure, title: 'API key is required' })
      return
    }
    await storage.setProviderKey(providerId, apiKey.trim(), baseUrl.trim() || undefined)
    await showToast({ style: Toast.Style.Success, title: `${label} key saved` })
    onSaved()
    pop()
  }

  return (
    <Form
      navigationTitle={label}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Save" onSubmit={() => void submit()} />
        </ActionPanel>
      }
    >
      {needsKey && <Form.PasswordField id="apiKey" title="API Key" value={apiKey} onChange={setApiKey} />}
      {providerId === 'ollama' && <Form.TextField id="baseUrl" title="Base URL" value={baseUrl} onChange={setBaseUrl} placeholder="http://localhost:11434/v1" />}
      <Form.Description text="Keys are stored on this device and used directly to call the provider — no proxy, plaintext (same as other extension credentials in this app), and never included in exports." />
    </Form>
  )
}

export default function ManageProvidersCommand() {
  const [keys, setKeys] = useState<ProviderKeyRecord[]>([])
  const { push } = useNavigation()

  const refresh = () => void storage.listProviderKeys().then(setKeys)
  useEffect(refresh, [])

  return (
    <List navigationTitle="AI Providers" searchBarPlaceholder="Search providers…">
      {PROVIDERS.map((provider) => {
        const saved = keys.find((k) => k.provider === provider.id)
        return (
          <List.Item
            key={provider.id}
            id={provider.id}
            title={provider.label}
            subtitle={saved ? 'Configured' : 'Not configured'}
            actions={
              <ActionPanel>
                <Action title="Set Key" onAction={() => push(<ProviderKeyForm providerId={provider.id} label={provider.label} needsKey={provider.needsKey} onSaved={refresh} />)} />
                {saved && <Action title="Remove Key" onAction={() => void storage.deleteProviderKey(provider.id).then(refresh)} />}
              </ActionPanel>
            }
          />
        )
      })}
    </List>
  )
}
