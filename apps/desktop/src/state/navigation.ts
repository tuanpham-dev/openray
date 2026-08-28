import type { PaletteItem } from '../components/types'

export type PaletteView =
  | { type: 'search' }
  /** `args`/`positionalArgument` are what the command was launched with,
   *  kept so a dev-mode hot reload re-runs it exactly as the user did
   *  rather than dropping back to an argument-less run. */
  | {
      type: 'extension'
      extensionId: string
      commandName: string
      title: string
      icon?: string | null
      args?: Record<string, string>
      positionalArgument?: string
    }
  | { type: 'confirm'; item: PaletteItem }
