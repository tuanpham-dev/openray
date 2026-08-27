import { Checkbox } from './Checkbox'
import { AliasField } from './AliasField'
import { HotkeyRecorder } from './HotkeyRecorder'
import { THEME_ICONS, ThemeIcon } from './extensionIcons'
import { IconGlyph } from '../../components/IconGlyph'
import type { CommandSettingsEntry, SettingsCommand } from '../../ipc/commandSettings'
import { AppWindowIcon, PuzzleIcon } from '../../components/icons'

function CommandIcon({ command }: { command: SettingsCommand }) {
  // Same resolution order as the root palette's `ItemIcon` (ListItem.tsx):
  // a command's `icon` (its own, or its extension's — see `Command.icon`'s
  // server-side fallback) is a name into `SYSTEM_ICON_NAMES`, an absolute
  // path, or literal text, in that order.
  if (command.icon) {
    return (
      <span className="openray-settings-row-icon">
        <IconGlyph icon={command.icon} size={18} imageClassName="openray-settings-row-icon-image" />
      </span>
    )
  }
  if (command.kind === 'app') {
    return (
      <ThemeIcon names={THEME_ICONS.applications}>
        <span className="openray-settings-row-icon">
          <AppWindowIcon size={18} />
        </span>
      </ThemeIcon>
    )
  }
  return <span className="openray-settings-row-icon"><PuzzleIcon size={18} /></span>
}

export function CommandRowHeader() {
  return (
    <div className="openray-command-row openray-command-row--header">
      <span>Name</span>
      <span>Alias</span>
      <span>Hotkey</span>
      <span>Enabled</span>
    </div>
  )
}

interface CommandRowProps {
  command: SettingsCommand
  entry: CommandSettingsEntry | undefined
  onAliasChange: (alias: string | null) => Promise<void>
  onHotkeyChange: (hotkey: string | null) => Promise<void>
  onEnabledChange: (enabled: boolean) => void
  /** Attached to the row's root element when it's the first visible row of
   *  a virtualized `CommandList`, so `useVirtualizedGrid` can measure a
   *  real rendered row height. */
  measureRef?: (el: HTMLDivElement | null) => void
}

export function CommandRow({ command, entry, onAliasChange, onHotkeyChange, onEnabledChange, measureRef }: CommandRowProps) {
  return (
    <div className="openray-command-row" ref={measureRef}>
      <span className="openray-command-row-name">
        <CommandIcon command={command} />
        <span className="openray-command-row-title">{command.title}</span>
      </span>
      <AliasField value={entry?.alias ?? null} onCommit={onAliasChange} />
      <HotkeyRecorder value={entry?.hotkey ?? null} onRecord={(hotkey) => onHotkeyChange(hotkey)} onClear={() => onHotkeyChange(null)} />
      <Checkbox id={`cmd-enabled-${command.id}`} checked={entry?.enabled ?? true} onChange={onEnabledChange} />
    </div>
  )
}
