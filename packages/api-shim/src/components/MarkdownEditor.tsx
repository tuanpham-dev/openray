import { createElement, type ReactElement, type ReactNode } from 'react'
import { NodeType } from '../node-types'
import { actionsSlot } from './host'

export interface MarkdownEditorProps {
  /** Identifies which document `value` belongs to — the host only re-seeds
   *  the live editor's content when this changes, so a same-document
   *  re-render (e.g. from an unrelated state update elsewhere in the
   *  extension) never clobbers in-progress typing with a stale `value`. */
  id: string | number
  value: string
  /** Fires with the current markdown a debounced settle time after the
   *  user stops typing (not per-keystroke — serializing the full document
   *  on every keystroke is real, avoidable cost a plain text field doesn't
   *  have). */
  onChange: (markdown: string) => void
  placeholder?: string
  /** T26: an `<ActionPanel>`, reachable via ⌘K — same `actions` contract
   *  every other top-level view (`Detail`, `List`, ...) already has. */
  actions?: ReactNode
}

/**
 * T25: renders a real, stateful TipTap editor host-side
 * (`apps/desktop/src/components/markdown-editor/MarkdownEditorCore.tsx`) —
 * OpenRay's own extension surface, not a Raycast primitive, so it's exported
 * from `@openray/extras` only (see `openray.cts`). The format bar and `:`-triggered
 * emoji suggestion are both baked into the host renderer unconditionally;
 * neither is configurable from here.
 */
export function MarkdownEditor(props: MarkdownEditorProps): ReactElement {
  const { actions, ...rest } = props
  return createElement(NodeType.MarkdownEditor, rest, actionsSlot(actions))
}
