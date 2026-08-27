import { useEffect, useState } from 'react'
import { Action, ActionPanel, List, confirmAlert, showHUD } from '@raycast/api'
import { refreshRootCommands } from '@openray/extras'
import { LANGUAGES } from '@openray/translate-core'
import { deleteTranslateCommand, listTranslateCommands, type TranslateCommand } from './storage'
import { TranslateCommandForm } from './create-translate-command'
import { TranslateBody } from './TranslateBody'

function languageName(code: string): string {
  if (code === 'auto') return 'Detect Language'
  return LANGUAGES.find((lang) => lang.code === code)?.name ?? code.toUpperCase()
}

export default function SearchTranslateCommands() {
  const [commands, setCommands] = useState<TranslateCommand[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const refresh = async () => {
    setIsLoading(true)
    setCommands(await listTranslateCommands())
    setIsLoading(false)
  }

  useEffect(() => {
    void refresh()
  }, [])

  const remove = async (command: TranslateCommand) => {
    const confirmed = await confirmAlert({ title: `Delete "${command.title}"?`, message: 'This cannot be undone.' })
    if (!confirmed) return
    await deleteTranslateCommand(command.id)
    await refreshRootCommands()
    await showHUD('Translate Command Deleted')
    await refresh()
  }

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search translate commands…" navigationTitle="Translate Commands">
      <List.EmptyView
        title="No Translate Commands"
        description="Create a fixed-language-pair command to get started."
        actions={
          <ActionPanel>
            <Action.Push title="Create Translate Command" target={<TranslateCommandForm onSaved={refresh} />} />
          </ActionPanel>
        }
      />
      {commands.map((command) => (
        <List.Item
          key={command.id}
          id={command.id}
          title={command.title}
          subtitle={`${languageName(command.sourceLang)} → ${languageName(command.targetLang)}`}
          actions={
            <ActionPanel>
              <Action.Push title="Run Command" target={<TranslateBody presetId={command.id} />} />
              <Action.Push title="Edit" target={<TranslateCommandForm command={command} onSaved={refresh} />} />
              <Action.Push title="Create Translate Command" target={<TranslateCommandForm onSaved={refresh} />} />
              <Action title="Delete" style="destructive" onAction={() => void remove(command)} />
            </ActionPanel>
          }
        />
      ))}
    </List>
  )
}
