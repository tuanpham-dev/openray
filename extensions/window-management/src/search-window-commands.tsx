import { useEffect, useState } from 'react'
import { Action, ActionPanel, confirmAlert, Icon, List, showHUD } from '@raycast/api'
import { refreshRootCommands } from '@openray/extras'
import { deleteWindowCommand, listWindowCommands, type WindowCommand } from './storage'
import { execute } from './provider'
import { WindowCommandForm } from './create-window-command'

function subtitle(command: WindowCommand): string {
  const unit = command.unit === 'percent' ? '%' : 'px'
  const pos = command.x != null && command.y != null ? `${command.x}${unit}, ${command.y}${unit}` : 'centered'
  return `${command.width}${unit} × ${command.height}${unit} — ${pos}`
}

export default function SearchWindowCommands() {
  const [commands, setCommands] = useState<WindowCommand[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const refresh = async () => {
    setIsLoading(true)
    setCommands(await listWindowCommands())
    setIsLoading(false)
  }

  useEffect(() => {
    void refresh()
  }, [])

  const remove = async (command: WindowCommand) => {
    const confirmed = await confirmAlert({ title: `Delete "${command.title}"?`, message: 'This cannot be undone.' })
    if (!confirmed) return
    await deleteWindowCommand(command.id)
    await refreshRootCommands()
    await showHUD('Window Command Deleted')
    await refresh()
  }

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search window commands…" navigationTitle="Window Commands">
      <List.EmptyView
        title="No Custom Window Commands"
        description="Create a window command to get started."
        actions={
          <ActionPanel>
            <Action.Push title="Create Window Command" icon={Icon.Plus} target={<WindowCommandForm onSaved={refresh} />} />
          </ActionPanel>
        }
      />
      {commands.map((command) => (
        <List.Item
          key={command.id}
          id={command.id}
          title={command.title}
          subtitle={subtitle(command)}
          actions={
            <ActionPanel>
              <Action title="Run" icon={Icon.ArrowRight} onAction={() => void execute(command.id)} />
              <Action.Push title="Edit" icon={Icon.Pencil} target={<WindowCommandForm command={command} onSaved={refresh} />} />
              <Action.Push title="Create Window Command" icon={Icon.Plus} target={<WindowCommandForm onSaved={refresh} />} />
              <Action title="Delete" icon={Icon.Trash} style="destructive" onAction={() => void remove(command)} />
            </ActionPanel>
          }
        />
      ))}
    </List>
  )
}
