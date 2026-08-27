import type { PaletteItem } from '../../components/types'
import { SYSTEM_ICON_NAMES } from '../../components/systemIconNames'

interface ConfirmViewProps {
  item: PaletteItem
  onConfirm: () => void
  onCancel: () => void
}

function ConfirmIcon({ item }: { item: PaletteItem }) {
  const SystemIcon = item.icon ? SYSTEM_ICON_NAMES[item.icon] : undefined
  if (SystemIcon) return <SystemIcon size={40} />
  return <span className="openray-confirm-icon">{item.icon}</span>
}

/**
 * The confirmation step Raycast shows before a destructive system command
 * (Shut Down, Restart, Log Out, Empty Trash) actually runs — a bound
 * hotkey routes here too (see `hotkey_dispatch::classify`), so a stray
 * keypress can't act on its own.
 */
export function ConfirmView({ item, onConfirm, onCancel }: ConfirmViewProps) {
  return (
    <div className="openray-confirm-view">
      <ConfirmIcon item={item} />
      <span className="openray-confirm-title">{item.title}</span>
      <span className="openray-confirm-message">Are you sure you want to {item.title.toLowerCase()}?</span>
      <div className="openray-confirm-actions">
        <button type="button" className="openray-confirm-cancel" onClick={onCancel}>
          Cancel <kbd>esc</kbd>
        </button>
        <button type="button" className="openray-confirm-confirm" onClick={onConfirm} autoFocus>
          Confirm <kbd>↵</kbd>
        </button>
      </div>
    </div>
  )
}
