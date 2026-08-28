import { useEffect } from 'react'
import { ActionItem } from './ActionItem'
import { useListNavigation } from './useListNavigation'
import { registerOverlay } from './overlay'
import type { PaletteAction } from '../state/actions'

interface ActionPanelProps {
  actions: PaletteAction[]
  onClose: () => void
}

export function ActionPanel({ actions, onClose }: ActionPanelProps) {
  const onActivate = (index: number) => {
    const action = actions[index]
    if (action) {
      void action.onAction()
      onClose()
    }
  }

  const { selectedIndex, setSelectedIndex } = useListNavigation(actions.length, onActivate)

  // All-or-nothing per panel: a mixed panel that indented only the rows
  // with an icon left the titles in a ragged column.
  const reserveIcon = actions.some((action) => action.icon !== undefined && action.icon !== null)

  // Signals to the view underneath that Escape belongs to this panel.
  useEffect(() => registerOverlay(), [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // Claimed for the same reason as App.tsx's Escape branch: an
        // unclaimed key re-dispatches through WebKitGTK's native path,
        // and that pass must never be left pending.
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div className="openray-action-panel">
      <div className="openray-action-panel-header">Actions</div>
      {actions.map((action, index) => (
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
  )
}
