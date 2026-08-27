import { useEffect, useState } from 'react'
import { ThemeProvider } from '../../theme/ThemeProvider'
import { SettingsSidebar, type SettingsSelection } from './SettingsSidebar'
import { GeneralPane } from './GeneralPane'
import { SyncPane } from './SyncPane'
import { AdvancedPane } from './AdvancedPane'
import { ApplicationsView, InstallExtensionView } from './ApplicationsView'
import { ExtensionSettingsView } from './ExtensionSettingsView'
import { getSettings, type Settings } from '../../ipc/settings'
import { listExtensions, setExtensionEnabled, uninstallExtension, type ExtensionEntry } from '../../ipc/extensions'
import {
  listCommandSettings,
  listSettingsCommands,
  setCommandAlias,
  setCommandEnabled,
  setCommandHotkey,
  type CommandSettingsEntry,
  type SettingsCommand,
} from '../../ipc/commandSettings'
import '../../theme/tokens.css'
import './settings.css'

export function SettingsWindow() {
  const [selection, setSelection] = useState<SettingsSelection>({ kind: 'general' })
  const [settings, setSettings] = useState<Settings | null>(null)
  const [extensions, setExtensions] = useState<ExtensionEntry[]>([])
  const [commands, setCommands] = useState<SettingsCommand[]>([])
  const [commandSettings, setCommandSettingsState] = useState<Record<string, CommandSettingsEntry>>({})

  const refresh = () =>
    Promise.all([listExtensions(), listSettingsCommands(), listCommandSettings()]).then(([exts, cmds, cmdSettings]) => {
      setExtensions(exts)
      setCommands(cmds)
      setCommandSettingsState(cmdSettings)
    })

  useEffect(() => {
    void getSettings().then(setSettings)
    void refresh()
  }, [])

  const toggleExtension = (id: string, enabled: boolean) => {
    setExtensions((current) => current.map((ext) => (ext.id === id ? { ...ext, enabled } : ext)))
    void setExtensionEnabled(id, enabled)
  }

  const uninstall = async (id: string) => {
    await uninstallExtension(id)
    setSelection((current) => (current.kind === 'extension' && current.id === id ? { kind: 'general' } : current))
    await refresh()
  }

  const updateAlias = async (commandId: string, alias: string | null) => {
    await setCommandAlias(commandId, alias)
    setCommandSettingsState((current) => ({
      ...current,
      [commandId]: { alias, hotkey: current[commandId]?.hotkey ?? null, enabled: current[commandId]?.enabled ?? true },
    }))
  }

  const updateHotkey = async (commandId: string, hotkey: string | null) => {
    await setCommandHotkey(commandId, hotkey)
    setCommandSettingsState((current) => ({
      ...current,
      [commandId]: { alias: current[commandId]?.alias ?? null, hotkey, enabled: current[commandId]?.enabled ?? true },
    }))
  }

  const updateEnabled = (commandId: string, enabled: boolean) => {
    setCommandSettingsState((current) => ({
      ...current,
      [commandId]: { alias: current[commandId]?.alias ?? null, hotkey: current[commandId]?.hotkey ?? null, enabled },
    }))
    void setCommandEnabled(commandId, enabled)
  }

  const selectedExtension = selection.kind === 'extension' ? extensions.find((ext) => ext.id === selection.id) : undefined

  return (
    <ThemeProvider>
      <div className="openray-settings-window">
        <SettingsSidebar extensions={extensions} selection={selection} onChange={setSelection} />
        <div className="openray-settings-content">
          {!settings ? (
            <div className="openray-empty-view">Loading…</div>
          ) : selection.kind === 'general' ? (
            <GeneralPane
              settings={settings}
              onChange={setSettings}
              builtinCommands={commands.filter((c) => c.kind === 'builtin')}
              commandSettings={commandSettings}
              onAlias={updateAlias}
              onHotkey={updateHotkey}
              onEnabled={updateEnabled}
            />
          ) : selection.kind === 'sync' ? (
            <SyncPane settings={settings} onChange={setSettings} />
          ) : selection.kind === 'advanced' ? (
            <AdvancedPane settings={settings} onChange={setSettings} />
          ) : selection.kind === 'applications' ? (
            <ApplicationsView commands={commands} commandSettings={commandSettings} onAlias={updateAlias} onHotkey={updateHotkey} onEnabled={updateEnabled} />
          ) : selection.kind === 'install' ? (
            <InstallExtensionView onInstalled={(id) => void refresh().then(() => setSelection({ kind: 'extension', id }))} />
          ) : selectedExtension ? (
            <ExtensionSettingsView
              extension={selectedExtension}
              commands={commands}
              commandSettings={commandSettings}
              settings={settings}
              onSettingsChange={setSettings}
              onToggleExtension={toggleExtension}
              onAlias={updateAlias}
              onHotkey={updateHotkey}
              onEnabled={updateEnabled}
              onUninstall={(id) => void uninstall(id)}
            />
          ) : (
            <div className="openray-empty-view">Extension not found.</div>
          )}
        </div>
      </div>
    </ThemeProvider>
  )
}
