import { useEffect, useState } from 'react'
import { List, Form, ActionPanel, Action, Icon, useNavigation, showToast, Toast, open } from '@raycast/api'
import * as storage from './storage'
import type { McpServerRecord } from './storage'
import * as oauth from './mcp/oauth'

function McpServerForm({ onSaved }: { onSaved: () => void }) {
  const [name, setName] = useState('')
  const [transport, setTransport] = useState<'stdio' | 'http'>('stdio')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [url, setUrl] = useState('')
  const [instructions, setInstructions] = useState('')
  const { pop } = useNavigation()

  const submit = async () => {
    if (!name.trim()) {
      await showToast({ style: Toast.Style.Failure, title: 'Name is required' })
      return
    }
    await storage.createMcpServer({
      name: name.trim(),
      transport,
      command: transport === 'stdio' ? command.trim() || undefined : undefined,
      args: transport === 'stdio' && args.trim() ? args.trim().split(/\s+/) : undefined,
      url: transport === 'http' ? url.trim() || undefined : undefined,
      instructions: instructions.trim() || undefined,
    })
    await showToast({ style: Toast.Style.Success, title: 'MCP server added' })
    onSaved()
    pop()
  }

  return (
    <Form
      navigationTitle="Add MCP Server"
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Add" onSubmit={() => void submit()} />
        </ActionPanel>
      }
    >
      <Form.TextField id="name" title="Name" value={name} onChange={setName} />
      <Form.Dropdown id="transport" title="Transport" value={transport} onChange={(value) => setTransport(value as 'stdio' | 'http')}>
        <Form.Dropdown.Item title="stdio (local command)" value="stdio" />
        <Form.Dropdown.Item title="HTTP" value="http" />
      </Form.Dropdown>
      {transport === 'stdio' ? (
        <>
          <Form.TextField id="command" title="Command" value={command} onChange={setCommand} placeholder="mcp-server-fs" />
          <Form.TextField id="args" title="Arguments" value={args} onChange={setArgs} placeholder="--root /home/me" />
        </>
      ) : (
        <Form.TextField id="url" title="URL" value={url} onChange={setUrl} placeholder="https://mcp.example.com/rpc" />
      )}
      <Form.TextArea id="instructions" title="Instructions" value={instructions} onChange={setInstructions} placeholder="Optional notes for yourself" />
    </Form>
  )
}

export default function ManageMcpServersCommand() {
  const [servers, setServers] = useState<McpServerRecord[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const { push } = useNavigation()

  const refresh = () => void storage.listMcpServers().then((list) => {
    setServers(list)
    setIsLoading(false)
  })

  useEffect(refresh, [])

  const startOAuth = async (server: McpServerRecord) => {
    if (!server.oauthType) return
    await showToast({ style: Toast.Style.Animated, title: 'Waiting for browser…' })
    try {
      const clientSecret = await storage.getMcpServerClientSecret(server.id)
      const result = await oauth.runOAuthFlow((authUrl) => open(authUrl), server, clientSecret)
      await storage.setMcpOAuthTokens(server.id, { accessToken: result.accessToken, refreshToken: result.refreshToken ?? null, expiresAt: result.expiresAt ?? null })
      await showToast({ style: Toast.Style.Success, title: 'Signed in' })
    } catch (err) {
      await showToast({ style: Toast.Style.Failure, title: 'OAuth failed', message: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <List isLoading={isLoading} navigationTitle="Manage MCP Servers" searchBarPlaceholder="Search MCP servers…">
      {servers.map((server) => (
        <List.Item
          key={server.id}
          id={server.id}
          title={server.name}
          subtitle={server.transport}
          accessories={[{ text: server.enabled ? 'Enabled' : 'Disabled' }, server.alwaysAllow ? { tag: 'Always Allow' } : {}]}
          actions={
            <ActionPanel>
              <Action
                title={server.enabled ? 'Disable' : 'Enable'}
                icon={server.enabled ? Icon.XMarkCircle : Icon.CheckCircle}
                onAction={() => void storage.setMcpServerEnabled(server.id, !server.enabled).then(refresh)}
              />
              <Action
                title={server.alwaysAllow ? 'Revoke Always Allow' : 'Always Allow Tool Calls'}
                icon={Icon.CheckCircle}
                onAction={() => void storage.setMcpServerAlwaysAllow(server.id, !server.alwaysAllow).then(refresh)}
              />
              {server.oauthType && <Action title="Sign in via OAuth" icon={Icon.ArrowRight} onAction={() => void startOAuth(server)} />}
              {server.oauthType && <Action title="Sign Out" icon="log-out" onAction={() => void storage.deleteMcpOAuthTokens(server.id).then(refresh)} />}
              <Action
                title="Delete"
                icon={Icon.Trash}
                shortcut={{ modifiers: ['cmd'], key: 'backspace' }}
                onAction={() => void storage.deleteMcpServer(server.id).then(refresh)}
              />
              <Action
                title="Add Server"
                icon={Icon.Plus}
                shortcut={{ modifiers: ['cmd'], key: 'n' }}
                onAction={() => push(<McpServerForm onSaved={refresh} />)}
              />
            </ActionPanel>
          }
        />
      ))}
      {servers.length === 0 && !isLoading && (
        <List.EmptyView
          title="No MCP servers"
          description="Add one to give AI Chat tool-calling access."
          actions={
            <ActionPanel>
              <Action title="Add Server" icon={Icon.Plus} onAction={() => push(<McpServerForm onSaved={refresh} />)} />
            </ActionPanel>
          }
        />
      )}
    </List>
  )
}
