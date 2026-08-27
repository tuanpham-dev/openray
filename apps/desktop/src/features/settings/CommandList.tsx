import { useMemo, useState } from 'react'
import { CommandRow, CommandRowHeader } from './CommandRow'
import { useVirtualizedGrid } from '../../extensions/useVirtualizedGrid'
import type { CommandSettingsEntry, SettingsCommand } from '../../ipc/commandSettings'

/** Above this row count, a filter input appears — short lists don't need
 *  one, long ones (quicklinks, hundreds of apps) do. */
const FILTER_THRESHOLD = 10
/** Above this row count, the list body becomes its own bounded scroll area
 *  windowed via `useVirtualizedGrid` (columns=1) — mounting every row at
 *  once gets slow and janky well before a list reaches hundreds of rows. */
const VIRTUALIZE_THRESHOLD = 40

interface CommandListProps {
  commands: SettingsCommand[]
  commandSettings: Record<string, CommandSettingsEntry>
  onAlias: (commandId: string, alias: string | null) => Promise<void>
  onHotkey: (commandId: string, hotkey: string | null) => Promise<void>
  onEnabled: (commandId: string, enabled: boolean) => void
  /** Always show the filter input, even at or under `FILTER_THRESHOLD`
   *  rows (Applications runs to hundreds and always wants one). */
  alwaysShowFilter?: boolean
  /** Shown instead of the row list when `commands` is empty. */
  emptyText?: string
}

export function CommandList({ commands, commandSettings, onAlias, onHotkey, onEnabled, alwaysShowFilter, emptyText }: CommandListProps) {
  const [filter, setFilter] = useState('')

  const filterLower = filter.trim().toLowerCase()
  const filtered = useMemo(() => {
    if (!filterLower) return commands
    return commands.filter((command) => {
      if (command.title.toLowerCase().includes(filterLower)) return true
      const alias = commandSettings[command.id]?.alias
      return alias ? alias.toLowerCase().includes(filterLower) : false
    })
  }, [commands, commandSettings, filterLower])

  const { containerRef, measureFirstCell, onScroll, startIndex, endIndex, topSpacerHeight, bottomSpacerHeight } = useVirtualizedGrid(
    filtered.length,
    1,
  )

  const showFilter = alwaysShowFilter || commands.length > FILTER_THRESHOLD
  const virtualize = filtered.length > VIRTUALIZE_THRESHOLD

  if (commands.length === 0) {
    return <p className="openray-extension-prefs-empty">{emptyText ?? 'No commands.'}</p>
  }

  const row = (command: SettingsCommand, measureRef?: (el: HTMLDivElement | null) => void) => (
    <CommandRow
      key={command.id}
      command={command}
      entry={commandSettings[command.id]}
      onAliasChange={(alias) => onAlias(command.id, alias)}
      onHotkeyChange={(hotkey) => onHotkey(command.id, hotkey)}
      onEnabledChange={(enabled) => onEnabled(command.id, enabled)}
      measureRef={measureRef}
    />
  )

  return (
    <div className="openray-command-list">
      {showFilter && (
        <input
          type="text"
          className="openray-command-list-filter"
          placeholder="Filter…"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      )}
      <CommandRowHeader />
      {filtered.length === 0 ? (
        <p className="openray-extension-prefs-empty">No matching commands.</p>
      ) : virtualize ? (
        <div ref={containerRef} className="openray-command-list-rows openray-command-list-rows--virtualized" onScroll={onScroll}>
          {topSpacerHeight > 0 && <div style={{ height: topSpacerHeight }} />}
          {filtered.slice(startIndex, endIndex).map((command, offset) => row(command, offset === 0 ? measureFirstCell : undefined))}
          {bottomSpacerHeight > 0 && <div style={{ height: bottomSpacerHeight }} />}
        </div>
      ) : (
        <div className="openray-command-list-rows">{filtered.map((command) => row(command))}</div>
      )}
    </div>
  )
}
