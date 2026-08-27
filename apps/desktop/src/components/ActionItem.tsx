import type { PaletteAction } from '../state/actions'
import { isHoverSelectionEnabled } from './hoverSelection'
import { useScrollIntoViewWhenSelected } from './useListNavigation'

interface ActionItemProps {
  action: PaletteAction
  selected: boolean
  onSelect: () => void
  onActivate: () => void
}

export function ActionItem({ action, selected, onSelect, onActivate }: ActionItemProps) {
  const ref = useScrollIntoViewWhenSelected<HTMLDivElement>(selected)

  return (
    <div
      ref={ref}
      className={`openray-action-item${selected ? ' openray-action-item--selected' : ''}`}
      onMouseEnter={() => {
        if (isHoverSelectionEnabled()) onSelect()
      }}
      onClick={onActivate}
    >
      {action.icon && <span className="openray-action-item-icon">{action.icon}</span>}
      <span className="openray-action-item-title">{action.title}</span>
      {action.shortcut && <kbd className="openray-action-item-shortcut">{action.shortcut}</kbd>}
    </div>
  )
}
