import { isHoverSelectionEnabled } from './hoverSelection'
import { ArrowRightIcon } from './icons'
import { IconGlyph } from './IconGlyph'
import type { InlineRow } from '../ipc/search'

interface InlineCardProps {
  row: InlineRow
  selected: boolean
  onSelect: () => void
  onActivate: () => void
}

/** The large Raycast-style result card for an `onQuery` row that opted in
 *  via `display: 'card'` — a raised panel under an optional `sectionLabel`
 *  heading. When `cardLeft` is present the card is a two-halves-plus-arrow
 *  layout (calculator's expression → result, translate's source → target);
 *  when it's absent, the left half falls back to the row's `icon` and no
 *  divider/arrow is drawn (notes' quick-capture row). Generalizes the
 *  deleted per-feature `CalcResult`/`TranslateResult`/`NoteCaptureResult`
 *  components, which all shared this exact card anatomy. */
export function InlineCard({ row, selected, onSelect, onActivate }: InlineCardProps) {
  const rightText = row.cardRight ?? row.title
  const hasTextLeft = row.cardLeft !== undefined

  return (
    <div className="openray-calc-section">
      {row.sectionLabel && <div className="openray-result-section-label">{row.sectionLabel}</div>}
      <div
        className={`openray-calc-card${selected ? ' openray-calc-card--selected' : ''}`}
        onMouseEnter={() => {
          if (isHoverSelectionEnabled()) onSelect()
        }}
        onClick={onActivate}
      >
        <span className="openray-calc-side openray-calc-expression">
          {hasTextLeft ? row.cardLeft : <IconGlyph icon={row.icon} size={15} />}
        </span>
        {hasTextLeft && (
          <span className="openray-calc-divider">
            <span className="openray-calc-arrow">
              <ArrowRightIcon />
            </span>
          </span>
        )}
        <span className="openray-calc-side openray-calc-value">{rightText}</span>
      </div>
    </div>
  )
}
