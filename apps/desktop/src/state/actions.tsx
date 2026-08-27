import type { ReactNode } from 'react'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { CopyIcon, ExternalLinkIcon, EyeOffIcon } from '../components/icons'
import { hidePalette } from '../ipc/window'
import type { PaletteItem } from '../components/types'

export interface PaletteAction {
  id: string
  title: string
  icon?: ReactNode
  shortcut?: string
  onAction: () => void | Promise<void>
}

function genericActions(item: PaletteItem, activate: (item: PaletteItem) => void): PaletteAction[] {
  return [
    {
      id: 'open',
      title: 'Open',
      icon: <ExternalLinkIcon size={15} />,
      shortcut: '↵',
      onAction: () => activate(item),
    },
    {
      id: 'copy-name',
      title: 'Copy Name',
      icon: <CopyIcon size={15} />,
      shortcut: '⌘C',
      onAction: () => writeText(item.title),
    },
    {
      id: 'hide',
      title: 'Hide OpenRay',
      icon: <EyeOffIcon size={15} />,
      shortcut: 'esc',
      onAction: () => hidePalette(),
    },
  ]
}

/**
 * `activate` replaces a plain `runCommand(item.id)` for the primary
 * action — the caller decides whether that means running immediately or,
 * for a destructive system command, showing a confirmation step first.
 */
export function getActionsForItem(item: PaletteItem, activate: (item: PaletteItem) => void): PaletteAction[] {
  return genericActions(item, activate)
}
