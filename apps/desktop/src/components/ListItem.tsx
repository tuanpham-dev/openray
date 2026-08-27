import type { PaletteItem, PaletteItemKind } from './types'
import { useScrollIntoViewWhenSelected } from './useListNavigation'
import { isHoverSelectionEnabled } from './hoverSelection'
import { IconGlyph } from './IconGlyph'

interface ListItemProps {
  item: PaletteItem
  selected: boolean
  onSelect: () => void
  onActivate: () => void
}

/** The trailing "Command"/"Application" label Raycast shows on every row. */
const TYPE_LABELS: Record<PaletteItemKind, string> = {
  app: 'Application',
  builtin: 'Command',
  extensionCommand: 'Command',
}

/** A row without an icon of its own already carries its owning
 *  extension's manifest icon by the time it reaches the frontend — see
 *  `Command.icon`'s server-side fallback in `extension_commands.rs`/
 *  `root_commands.rs`/`inline_query.rs`. Only apps/builtins with no icon
 *  at all (rare — the OS scanner and Settings' own icon are almost always
 *  present) fall through to the letter avatar. */
function ItemIcon({ item }: { item: PaletteItem }) {
  return (
    <IconGlyph
      icon={item.icon}
      size={18}
      svgClassName="openray-list-item-icon-svg"
      imageClassName="openray-list-item-icon-image"
      textClassName="openray-list-item-icon"
      fallback={<span className="openray-list-item-icon openray-list-item-icon-fallback">{item.title.charAt(0).toUpperCase()}</span>}
    />
  )
}

export function ListItem({ item, selected, onSelect, onActivate }: ListItemProps) {
  const typeLabel = TYPE_LABELS[item.kind]
  // Apps carry the literal subtitle "Application", which the trailing type
  // label already says — don't print it twice.
  const subtitle = item.subtitle && item.subtitle !== typeLabel ? item.subtitle : undefined
  const ref = useScrollIntoViewWhenSelected<HTMLDivElement>(selected)

  return (
    <div
      ref={ref}
      className={`openray-list-item${selected ? ' openray-list-item--selected' : ''}`}
      onMouseEnter={() => {
        if (isHoverSelectionEnabled()) onSelect()
      }}
      onClick={onActivate}
    >
      <ItemIcon item={item} />
      <span className="openray-list-item-main">
        <span className="openray-list-item-title">{item.title}</span>
        {subtitle && <span className="openray-list-item-subtitle">{subtitle}</span>}
        {item.alias && <span className="openray-list-item-alias">{item.alias}</span>}
      </span>
      {item.accessory && <span className="openray-list-item-accessory">{item.accessory}</span>}
      <span className="openray-list-item-type">{typeLabel}</span>
    </div>
  )
}
