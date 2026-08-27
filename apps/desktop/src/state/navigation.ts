import type { PaletteItem } from '../components/types'

export type PaletteView =
  | { type: 'search' }
  /** Generic argument-prompt bar for any command whose `requiresArgument`
   *  flag is set — the name is a holdover from when quicklinks were the
   *  only such command (T15 migrated quicklinks itself to an extension,
   *  but any extension command declaring `arguments` in its manifest
   *  still reaches this same view). */
  | { type: 'quicklink-argument'; item: PaletteItem }
  | { type: 'extension'; extensionId: string; commandName: string }
  | { type: 'confirm'; item: PaletteItem }
