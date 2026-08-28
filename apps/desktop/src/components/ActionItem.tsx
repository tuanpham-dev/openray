import type { PaletteAction } from '../state/actions'
import { isHoverSelectionEnabled } from './hoverSelection'
import { IconGlyph } from './IconGlyph'
import { useScrollIntoViewWhenSelected } from './useListNavigation'

interface ActionItemProps {
  action: PaletteAction
  selected: boolean
  /** Whether any action in this panel has an icon — when one does, every
   *  row reserves the slot so the titles line up in a column. */
  reserveIcon: boolean
  onSelect: () => void
  onActivate: () => void
}

export function ActionItem({ action, selected, reserveIcon, onSelect, onActivate }: ActionItemProps) {
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
      {reserveIcon && (
        <span className="openray-action-item-icon">
          {/* An extension's action carries its icon as a *name* ("trash"),
              which has to be resolved the same way every other icon in the
              app is — rendering it directly printed the literal word over
              the action's title. First-party actions pass an element. */}
          {typeof action.icon === 'string' ? (
            <IconGlyph
              icon={action.icon}
              size={15}
              imageClassName="openray-action-item-icon-image"
              textClassName="openray-action-item-icon-text"
            />
          ) : (
            action.icon
          )}
        </span>
      )}
      <span className="openray-action-item-title">{action.title}</span>
      {action.shortcut && <kbd className="openray-action-item-shortcut">{action.shortcut}</kbd>}
    </div>
  )
}
