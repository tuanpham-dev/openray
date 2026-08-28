export type PaletteItemKind = 'app' | 'builtin' | 'extensionCommand'

export interface CommandArgumentOption {
  title: string
  value: string
}

export interface CommandArgument {
  name: string
  type: 'text' | 'password' | 'dropdown'
  placeholder?: string | null
  required: boolean
  data?: CommandArgumentOption[] | null
}

export interface PaletteItem {
  id: string
  title: string
  subtitle?: string
  icon?: string | null
  accessory?: string
  /** User-assigned search alias, shown as a pill beside the title. */
  alias?: string
  kind: PaletteItemKind
  /** Fields this command collects before running, in manifest order.
   *  Rendered inline in the search bar (see `ArgumentFields`), the way
   *  Raycast does it — never as a separate screen. */
  arguments?: CommandArgument[]
  /** T14: set only for a `root-provider`-contributed row whose extension
   * declared it needs confirmation (e.g. `extensions/system-commands`'
   * destructive ids). */
  needsConfirm?: boolean
}
