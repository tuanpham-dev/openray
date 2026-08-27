import { ListItem } from './ListItem'
import type { PaletteItem } from './types'

interface ResultListProps {
  items: PaletteItem[]
  selectedIndex: number
  onSelectIndex: (index: number) => void
  onActivateIndex: (index: number) => void
  /** Group heading above the rows, as Raycast labels its result groups. */
  sectionLabel?: string
}

export function ResultList({
  items,
  selectedIndex,
  onSelectIndex,
  onActivateIndex,
  sectionLabel = 'Results',
}: ResultListProps) {
  if (items.length === 0) {
    return <div className="openray-empty-view">No results</div>
  }

  return (
    <div className="openray-result-list">
      <div className="openray-result-section-label">{sectionLabel}</div>
      {items.map((item, index) => (
        <ListItem
          key={item.id}
          item={item}
          selected={index === selectedIndex}
          onSelect={() => onSelectIndex(index)}
          onActivate={() => onActivateIndex(index)}
        />
      ))}
    </div>
  )
}
