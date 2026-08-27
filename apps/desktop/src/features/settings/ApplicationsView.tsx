import { useState } from 'react'
import { CommandList } from './CommandList'
import { installExtensionFromPath, installExtensionFromSlug } from '../../ipc/extensions'
import type { CommandSettingsEntry, SettingsCommand } from '../../ipc/commandSettings'

interface ApplicationsViewProps {
  commands: SettingsCommand[]
  commandSettings: Record<string, CommandSettingsEntry>
  onAlias: (commandId: string, alias: string | null) => Promise<void>
  onHotkey: (commandId: string, hotkey: string | null) => Promise<void>
  onEnabled: (commandId: string, enabled: boolean) => void
}

export function ApplicationsView({ commands, commandSettings, onAlias, onHotkey, onEnabled }: ApplicationsViewProps) {
  const appCommands = commands.filter((command) => command.kind === 'app')

  return (
    <div className="openray-extension-view">
      <header className="openray-settings-view-heading">
        <h2>Applications</h2>
      </header>
      <section className="openray-extension-view-section">
        <CommandList
          commands={appCommands}
          commandSettings={commandSettings}
          onAlias={onAlias}
          onHotkey={onHotkey}
          onEnabled={onEnabled}
          alwaysShowFilter
          emptyText="No applications found."
        />
      </section>
    </div>
  )
}

interface InstallExtensionViewProps {
  onInstalled: (id: string) => void
}

export function InstallExtensionView({ onInstalled }: InstallExtensionViewProps) {
  const [source, setSource] = useState('')
  const [installing, setInstalling] = useState(false)
  const [installError, setInstallError] = useState<string | null>(null)

  const install = async () => {
    const value = source.trim()
    if (!value) return
    setInstalling(true)
    setInstallError(null)
    try {
      const entry = value.startsWith('/') || value.startsWith('.') ? await installExtensionFromPath(value) : await installExtensionFromSlug(value)
      setSource('')
      onInstalled(entry.id)
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : String(err))
    } finally {
      setInstalling(false)
    }
  }

  return (
    <div className="openray-extension-view">
      <header className="openray-settings-view-heading">
        <h2>Install Extension</h2>
      </header>
      <section className="openray-extension-view-section">
        <div className="openray-extensions-install">
          <input
            type="text"
            placeholder="Local path or raycast/extensions slug (e.g. 8ball)"
            value={source}
            onChange={(event) => setSource(event.target.value)}
            disabled={installing}
          />
          <button type="button" onClick={() => void install()} disabled={installing || !source.trim()}>
            {installing ? 'Installing…' : 'Install'}
          </button>
        </div>
        {installError && <p className="openray-extensions-install-error">{installError}</p>}
      </section>
    </div>
  )
}
