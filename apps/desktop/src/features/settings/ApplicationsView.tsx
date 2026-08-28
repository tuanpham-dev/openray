import { useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { CommandList } from './CommandList'
import { RegistriesSection } from './RegistriesSection'
import { developExtension, installExtensionFromArchive, installExtensionFromPath, installExtensionFromSlug } from '../../ipc/extensions'
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
    // `--fill` (not the centered, content-height `openray-extension-view`
    // default): the app list is the whole point of this view and runs to
    // hundreds of rows, so it takes the window's full height and scrolls
    // inside itself rather than stopping at the virtualizer's default
    // 340px box with dead space underneath.
    <div className="openray-extension-view openray-extension-view--fill">
      <header className="openray-settings-view-heading">
        <h2>Applications</h2>
      </header>
      <section className="openray-extension-view-section openray-extension-view-section--fill">
        <CommandList
          commands={appCommands}
          commandSettings={commandSettings}
          onAlias={onAlias}
          onHotkey={onHotkey}
          onEnabled={onEnabled}
          alwaysShowFilter
          fill
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
  const [developing, setDeveloping] = useState(false)
  const [developError, setDevelopError] = useState<string | null>(null)

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

  // A packed archive: no build happens here at all, so this is the one
  // install that works on a machine with no toolchain.
  const installArchive = async () => {
    const picked = await open({
      multiple: false,
      title: 'Choose an extension archive',
      filters: [{ name: 'OpenRay extension', extensions: ['orx'] }],
    })
    if (typeof picked !== 'string') return
    setInstalling(true)
    setInstallError(null)
    try {
      const entry = await installExtensionFromArchive(picked)
      onInstalled(entry.id)
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : String(err))
    } finally {
      setInstalling(false)
    }
  }

  // Dev mode takes a *folder*, never a typed path: the install field's
  // "does it start with / or .?" heuristic is exactly the kind of guess a
  // picker removes, and an author pointing at their own checkout is the
  // one case where getting the path wrong is most annoying.
  const develop = async () => {
    const picked = await open({ directory: true, multiple: false, title: 'Choose an extension folder' })
    if (typeof picked !== 'string') return
    setDeveloping(true)
    setDevelopError(null)
    try {
      const entry = await developExtension(picked)
      onInstalled(entry.id)
    } catch (err) {
      setDevelopError(err instanceof Error ? err.message : String(err))
    } finally {
      setDeveloping(false)
    }
  }

  return (
    <div className="openray-extension-view">
      <header className="openray-settings-view-heading">
        <h2>Add Extension</h2>
      </header>
      <section className="openray-extension-view-section">
        <h3>Install</h3>
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
          <button type="button" onClick={() => void installArchive()} disabled={installing}>
            From File…
          </button>
        </div>
        <p className="openray-extensions-install-hint">
          A path or slug is built here, which needs git and npm. A packed <code>.orx</code> file installs as-is.
        </p>
        {installError && <p className="openray-extensions-install-error">{installError}</p>}
      </section>
      <section className="openray-extension-view-section openray-extension-view-section--divided">
        <h3>Registries</h3>
        <RegistriesSection />
      </section>
      <section className="openray-extension-view-section openray-extension-view-section--divided">
        <h3>Develop</h3>
        <p className="openray-extensions-install-hint">
          Build an extension from the folder you're editing. Its commands appear in the palette straight away, and every save
          rebuilds and reloads them — nothing is copied, so your folder stays the only source of truth.
        </p>
        <div className="openray-extensions-install">
          <button type="button" onClick={() => void develop()} disabled={developing}>
            {developing ? 'Building…' : 'Choose Folder…'}
          </button>
        </div>
        {developError && <p className="openray-extensions-install-error">{developError}</p>}
      </section>
    </div>
  )
}
