import { useEffect, useMemo, useRef, useState } from 'react'
import { ActionItem } from './ActionItem'
import { useListNavigation } from './useListNavigation'
import { registerOverlay } from './overlay'
import { fuzzyFilter } from '../extensions/fuzzyMatch'
import type { PaletteAction } from '../state/actions'

interface ActionPanelProps {
  actions: PaletteAction[]
  onClose: () => void
}

export function ActionPanel({ actions, onClose }: ActionPanelProps) {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // Raycast's panel filters its actions as you type — with a long panel
  // (a file's dozen "Copy …" variants) the arrow keys alone are slow.
  const filtered = useMemo(() => fuzzyFilter(actions, query.trim(), (action) => action.title), [actions, query])

  const onActivate = (index: number) => {
    const action = filtered[index]
    if (action) {
      void action.onAction()
      onClose()
    }
  }

  const { selectedIndex, setSelectedIndex } = useListNavigation(filtered.length, onActivate, true, query)

  // All-or-nothing per panel: a mixed panel that indented only the rows
  // with an icon left the titles in a ragged column.
  const reserveIcon = filtered.some((action) => action.icon !== undefined && action.icon !== null)

  // Signals to the view underneath that Escape belongs to this panel.
  useEffect(() => registerOverlay(), [])

  // The panel's own field takes the keyboard while it's up — otherwise
  // typing would land in the search bar underneath and filter the *list*
  // instead of the actions — and hands focus back to wherever it came
  // from (the search field, a form control) once the panel goes away.
  useEffect(() => {
    const previous = document.activeElement
    inputRef.current?.focus()
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])

  // Escape works in two steps, the way Raycast's panel does: a typed
  // filter is cleared first, and only an already-empty field closes the
  // panel (handing focus back to the search bar via the effect above).
  const queryRef = useRef(query)
  queryRef.current = query
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // Claimed for the same reason as App.tsx's Escape branch: an
        // unclaimed key re-dispatches through WebKitGTK's native path,
        // and that pass must never be left pending.
        event.preventDefault()
        if (queryRef.current) setQuery('')
        else onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div className="openray-action-panel">
      <div className="openray-action-panel-header">Actions</div>
      <div className="openray-action-panel-list">
        {filtered.length === 0 && <div className="openray-action-panel-empty">No matching actions</div>}
        {filtered.map((action, index) => (
          <ActionItem
            key={action.id}
            action={action}
            selected={index === selectedIndex}
            reserveIcon={reserveIcon}
            onSelect={() => setSelectedIndex(index)}
            onActivate={() => onActivate(index)}
          />
        ))}
      </div>
      {/* At the bottom, nearest the footer the panel pops out of — where
          Raycast puts it. */}
      <input
        ref={inputRef}
        className="openray-action-panel-search"
        type="text"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search for actions…"
        aria-label="Search actions"
        spellCheck={false}
      />
    </div>
  )
}
