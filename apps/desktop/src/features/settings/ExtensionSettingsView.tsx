import { useEffect, useMemo, useState } from 'react'
import { Toggle } from './Toggle'
import { CommandList } from './CommandList'
import { ExtensionPrefsForm } from './ExtensionPrefsForm'
import { BUILTIN_PREFS } from './builtinPrefs'
import { THEME_ICONS, ThemeIcon } from './extensionIcons'
import { PuzzleIcon } from '../../components/icons'
import { IconGlyph } from '../../components/IconGlyph'
import { parseExtensionCommandId } from '../../extensions/commandId'
import type { DevBuildEvent, ExtensionEntry } from '../../ipc/extensions'
import type { CommandSettingsEntry, SettingsCommand } from '../../ipc/commandSettings'
import type { Settings } from '../../ipc/settings'

interface ExtensionSettingsViewProps {
  extension: ExtensionEntry
  commands: SettingsCommand[]
  commandSettings: Record<string, CommandSettingsEntry>
  settings: Settings
  onSettingsChange: (settings: Settings) => void
  onToggleExtension: (id: string, enabled: boolean) => void
  onAlias: (commandId: string, alias: string | null) => Promise<void>
  onHotkey: (commandId: string, hotkey: string | null) => Promise<void>
  onEnabled: (commandId: string, enabled: boolean) => void
  onUninstall: (id: string) => void
  /** The folder being watched, when this extension is in dev mode and its
   *  watcher is live. A dev extension with no session is still registered
   *  and runnable — it just isn't picking up edits (see `dev_extensions`). */
  devDir?: string
  /** The most recent dev rebuild of *this* extension, when there's been
   *  one this session — the only place a build error is durable rather
   *  than a toast that scrolls past. */
  lastDevBuild?: DevBuildEvent
  onStopDeveloping: (id: string) => void
  onResumeDeveloping: (dir: string) => void
  onRemoveDev: (id: string) => void
}

export function ExtensionSettingsView({
  extension,
  commands,
  commandSettings,
  settings,
  onSettingsChange,
  onToggleExtension,
  onAlias,
  onHotkey,
  onEnabled,
  onUninstall,
  devDir,
  lastDevBuild,
  onStopDeveloping,
  onResumeDeveloping,
  onRemoveDev,
}: ExtensionSettingsViewProps) {
  const isDev = extension.source === 'dev'
  const ownCommands = useMemo(
    () => commands.filter((command) => parseExtensionCommandId(command.id)?.extensionId === extension.id),
    [commands, extension.id],
  )

  const BuiltinPrefsSection = BUILTIN_PREFS[extension.id]

  // Whether the schema-driven form has anything isn't known until its own
  // fetch resolves (see ExtensionPrefsForm's onEmptyChange) — reset to the
  // "nothing yet" default whenever the selected extension changes, so a
  // stale true from the previous extension can't flash the heading for one
  // that has no schema prefs of its own.
  const [hasSchemaPrefs, setHasSchemaPrefs] = useState(false)
  useEffect(() => setHasSchemaPrefs(false), [extension.id])

  const showPreferences = Boolean(BuiltinPrefsSection) || hasSchemaPrefs
  const showCommands = ownCommands.length > 0

  return (
    <div className="openray-extension-view">
      <header className="openray-extension-view-header">
        <span className="openray-extension-view-icon">
          <IconGlyph
            icon={extension.icon}
            size={32}
            imageClassName="openray-settings-row-icon-image"
            fallback={
              <ThemeIcon names={THEME_ICONS.extension}>
                <PuzzleIcon size={32} />
              </ThemeIcon>
            }
          />
        </span>
        <h2>{extension.title}</h2>
        {extension.description && <p className="openray-extension-view-description">{extension.description}</p>}
        <span className="openray-extension-view-meta">
          {isDev ? 'In development' : extension.source === 'builtin' ? 'Built-in' : 'Extension'} · {extension.id}
          {extension.version && <> · v{extension.version}</>}
          {isDev && extension.path && <> · {extension.path}</>}
        </span>
        {extension.sourceUrl && <span className="openray-extension-view-meta">Installed from {extension.sourceUrl}</span>}
        {isDev && !devDir && (
          <span className="openray-extension-view-meta openray-extension-view-meta--warning">
            Not watching — edits won't rebuild until you resume.
          </span>
        )}

        <div className="openray-extension-view-actions">
          {isDev ? (
            <>
              <button type="button" className="openray-extensions-uninstall" onClick={() => onRemoveDev(extension.id)}>
                Remove
              </button>
              {devDir ? (
                <button type="button" className="openray-extensions-uninstall" onClick={() => onStopDeveloping(extension.id)}>
                  Stop Developing
                </button>
              ) : (
                extension.path && (
                  <button type="button" className="openray-extensions-uninstall" onClick={() => onResumeDeveloping(extension.path as string)}>
                    Resume Developing
                  </button>
                )
              )}
            </>
          ) : (
            extension.source !== 'builtin' && (
              <button type="button" className="openray-extensions-uninstall" onClick={() => onUninstall(extension.id)}>
                Uninstall
              </button>
            )
          )}
          <Toggle id={`ext-enabled-${extension.id}`} checked={extension.enabled} onChange={(checked) => onToggleExtension(extension.id, checked)} />
        </div>
      </header>

      {isDev && lastDevBuild && (
        <section className="openray-extension-view-section">
          <h3>Last Build</h3>
          {lastDevBuild.errors.length > 0 ? (
            <ul className="openray-extensions-build-errors">
              {lastDevBuild.errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          ) : (
            <p className="openray-extensions-install-hint">
              Built {lastDevBuild.commands.length} command{lastDevBuild.commands.length === 1 ? '' : 's'} in{' '}
              {lastDevBuild.durationMs}ms.
            </p>
          )}
        </section>
      )}

      {/* `display: contents` when nothing to show — ExtensionPrefsForm still
          needs to mount to tell us (via onEmptyChange) whether it has
          anything, but a wrapper with only a null child shouldn't claim a
          flex gap's worth of empty space. */}
      <section className="openray-extension-view-section" style={showPreferences ? undefined : { display: 'contents' }}>
        {showPreferences && <h3>Preferences</h3>}
        {BuiltinPrefsSection && <BuiltinPrefsSection settings={settings} onChange={onSettingsChange} />}
        <ExtensionPrefsForm extensionId={extension.id} hideEmptyState onEmptyChange={(empty) => setHasSchemaPrefs(!empty)} />
      </section>

      {showCommands && (
        <section className={`openray-extension-view-section${showPreferences ? ' openray-extension-view-section--divided' : ''}`}>
          <h3>Commands</h3>
          <CommandList commands={ownCommands} commandSettings={commandSettings} onAlias={onAlias} onHotkey={onHotkey} onEnabled={onEnabled} />
        </section>
      )}
    </div>
  )
}
