import { useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { ThemeProvider } from '../../theme/ThemeProvider'
import { SettingsSidebar, type SettingsSelection } from './SettingsSidebar'
import { GeneralPane } from './GeneralPane'
import { ImportExportPane } from './ImportExportPane'
import { AdvancedPane } from './AdvancedPane'
import { ApplicationsView, InstallExtensionView } from './ApplicationsView'
import { ExtensionSettingsView } from './ExtensionSettingsView'
import { getSettings, type Settings } from '../../ipc/settings'
import {
  developExtension,
  listDevExtensions,
  listExtensions,
  removeDevExtension,
  setExtensionEnabled,
  stopDeveloping,
  uninstallExtension,
  type DevBuildEvent,
  type DevSession,
  type ExtensionEntry,
} from '../../ipc/extensions'
import type { UpdateReport } from '../../ipc/registry'
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

/**
 * The pane named by the window's own URL.
 *
 * `openExtensionPreferences()` / `openCommandPreferences()` deep-link here
 * (`#/settings?extension=<id>&command=<name>`) rather than dropping the
 * user on General to hunt for the extension themselves — see
 * `infrastructure::window::SettingsTarget`, which builds these.
 */
function selectionFromHash(): SettingsSelection {
  const query = window.location.hash.split('?')[1]
  if (!query) return { kind: 'general' }
  const params = new URLSearchParams(query)
  const extensionId = params.get('extension')
  if (!extensionId) return { kind: 'general' }
  const commandName = params.get('command')
  if (commandName) return { kind: 'command', extensionId, commandName }
  return { kind: 'extension', id: extensionId }
}

export function SettingsWindow() {
  const [selection, setSelection] = useState<SettingsSelection>(selectionFromHash)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [extensions, setExtensions] = useState<ExtensionEntry[]>([])
  const [commands, setCommands] = useState<SettingsCommand[]>([])
  const [commandSettings, setCommandSettingsState] = useState<Record<string, CommandSettingsEntry>>({})
  const [devSessions, setDevSessions] = useState<DevSession[]>([])
  const [devBuild, setDevBuild] = useState<DevBuildEvent | null>(null)

  // A second `openExtensionPreferences()` while this window is already
  // open re-points it (the Rust side rewrites the hash), which is only
  // visible if we listen for it.
  useEffect(() => {
    const onHashChange = () => setSelection(selectionFromHash())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const refresh = () =>
    Promise.all([listExtensions(), listSettingsCommands(), listCommandSettings(), listDevExtensions()]).then(
      ([exts, cmds, cmdSettings, sessions]) => {
        setExtensions(exts)
        setCommands(cmds)
        setCommandSettingsState(cmdSettings)
        setDevSessions(sessions)
      },
    )

  useEffect(() => {
    void getSettings().then(setSettings)
    void refresh()
  }, [])

  // An automatic update installs a new version underneath whatever is on
  // screen (see `application::auto_update`), so the list has to re-read or
  // it keeps showing the version that was just replaced.
  useEffect(() => {
    const unlisten = listen<UpdateReport>('extension-updates', (event) => {
      if (event.payload.applied.some((outcome) => !outcome.error)) void refresh()
    })
    return () => {
      void unlisten.then((fn) => fn())
    }
  }, [])

  // A dev rebuild can change the manifest (new commands, renamed title,
  // added preferences) — the platform re-registers before emitting, so
  // re-reading here is what makes those appear without reopening Settings.
  // The build itself is kept so the extension's own page can show whether
  // the last one failed, which is otherwise invisible outside the palette's
  // transient toast.
  useEffect(() => {
    const unlisten = listen<DevBuildEvent>('extension-dev-build', (event) => {
      setDevBuild(event.payload)
      if (event.payload.manifestChanged) void refresh()
    })
    return () => {
      void unlisten.then((fn) => fn())
    }
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

  const stopDev = async (id: string) => {
    await stopDeveloping(id)
    await refresh()
  }

  const resumeDev = async (dir: string) => {
    await developExtension(dir)
    await refresh()
  }

  const removeDev = async (id: string) => {
    await removeDevExtension(id)
    setSelection((current) => (current.kind === 'extension' && current.id === id ? { kind: 'general' } : current))
    await refresh()
  }

  // A `command` selection renders that command's own extension pane, with
  // its preference group highlighted — the groups already exist there, so
  // deep-linking beats building a second surface that shows the same rows.
  const selectedExtensionId =
    selection.kind === 'extension' ? selection.id : selection.kind === 'command' ? selection.extensionId : undefined
  const selectedExtension = selectedExtensionId ? extensions.find((ext) => ext.id === selectedExtensionId) : undefined
  const highlightCommand = selection.kind === 'command' ? selection.commandName : undefined

  return (
    <ThemeProvider>
      <div className="openray-settings-window">
        <SettingsSidebar extensions={extensions} selection={selection} onChange={setSelection} />
        <div className="openray-settings-content">
          {!settings ? (
            <div className="openray-empty-view">Loading…</div>
          ) : selection.kind === 'general' ? (
            <GeneralPane settings={settings} onChange={setSettings} />
          ) : selection.kind === 'transfer' ? (
            <ImportExportPane />
          ) : selection.kind === 'advanced' ? (
            <AdvancedPane settings={settings} onChange={setSettings} />
          ) : selection.kind === 'applications' ? (
            <ApplicationsView commands={commands} commandSettings={commandSettings} onAlias={updateAlias} onHotkey={updateHotkey} onEnabled={updateEnabled} />
          ) : selection.kind === 'install' ? (
            <InstallExtensionView onInstalled={(id) => void refresh().then(() => setSelection({ kind: 'extension', id }))} />
          ) : selectedExtension ? (
            <ExtensionSettingsView
              highlightCommand={highlightCommand}
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
              devDir={devSessions.find((session) => session.id === selectedExtension.id)?.dir}
              lastDevBuild={devBuild?.extensionId === selectedExtension.id ? devBuild : undefined}
              onStopDeveloping={(id) => void stopDev(id)}
              onResumeDeveloping={(dir) => void resumeDev(dir)}
              onRemoveDev={(id) => void removeDev(id)}
            />
          ) : (
            <div className="openray-empty-view">Extension not found.</div>
          )}
        </div>
      </div>
    </ThemeProvider>
  )
}
