import { invoke } from '@tauri-apps/api/core'
import type { PaletteItem, PaletteItemKind } from '../components/types'

interface CommandDto {
  id: string
  title: string
  subtitle?: string | null
  icon?: string | null
  alias?: string | null
  kind: PaletteItemKind
  keywords: string[]
  requiresArgument: boolean
  needsConfirm: boolean
}

/** T21: one row an extension's `onQuery` export contributed for the
 *  query that was current when the backend's `inline-rows` event fired —
 *  see `application::inline_query`. Arrives via that event, not as part
 *  of `search()`'s own return value, since it's a separate async round
 *  trip to the extension host that must never block the synchronous
 *  results list. */
export interface InlineRow {
  id: string
  title: string
  subtitle?: string
  icon?: string | null
  value?: string
  /** T23: an alternate, unformatted form of `value` — backs the
   *  secondary-action copy variant (⌘↵). Falls back to `value` when
   *  absent. */
  valueRaw?: string
  /** T26: an "activatable" row — set together with `argument`/`extensionId`,
   *  mutually exclusive with `value`/`valueRaw` in practice (every row
   *  built so far is one shape or the other). When present, Enter runs
   *  this extension command (with `argument`) via the same launch path a
   *  manifest command already uses, instead of copying `value` to the
   *  clipboard — notes' quick-capture row is the first row shaped this
   *  way, since "create a note from this text" has no sensible
   *  clipboard-copy reading. */
  commandName?: string
  /** Always set by Rust when `commandName` is present — never trusted
   *  from the extension's own reply there, so always present here too. */
  extensionId?: string
  argument?: string
  /** Opts into the large Raycast-style result card instead of a plain
   *  `ListItem` row — see `InlineCard`. Only recognized value is `'card'`. */
  display?: 'card'
  /** Heading shown above the card, e.g. "Calculator" or "Translate to
   *  German". Only meaningful when `display` is `'card'`. */
  sectionLabel?: string
  /** Left half of the card (expression / source text). When absent, the
   *  card renders `icon` there instead and skips the divider/arrow. */
  cardLeft?: string
  /** Right half of the card; falls back to `title` when absent. */
  cardRight?: string
}

interface SearchResponseDto {
  commands: CommandDto[]
}

export interface SearchResult {
  items: PaletteItem[]
}

export async function search(query: string): Promise<SearchResult> {
  const response = await invoke<SearchResponseDto>('search', { query })
  return {
    items: response.commands.map((command) => ({
      id: command.id,
      title: command.title,
      subtitle: command.subtitle ?? undefined,
      icon: command.icon,
      alias: command.alias ?? undefined,
      kind: command.kind,
      requiresArgument: command.requiresArgument,
      needsConfirm: command.needsConfirm || undefined,
    })),
  }
}

export function runCommand(id: string): Promise<void> {
  return invoke('run_command', { id })
}

export function runCommandWithArgument(id: string, argument: string): Promise<void> {
  return invoke('run_command_with_argument', { id, argument })
}
