export type PaletteItemKind = 'app' | 'builtin' | 'extensionCommand'

export interface PaletteItem {
  id: string
  title: string
  subtitle?: string
  icon?: string | null
  accessory?: string
  /** User-assigned search alias, shown as a pill beside the title. */
  alias?: string
  kind: PaletteItemKind
  requiresArgument?: boolean
  /** T14: set only for a `root-provider`-contributed row whose extension
   * declared it needs confirmation (e.g. `extensions/system-commands`'
   * destructive ids). */
  needsConfirm?: boolean
}
