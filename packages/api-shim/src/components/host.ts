import { createElement, type ReactElement, type ReactNode } from 'react'
import { NodeType } from '../node-types'

/**
 * Wraps a component's `actions` prop into a real host child tagged
 * `__actions`, since `serializeProps` never ships `actions` as a prop (see
 * its comment for why). Every component that accepts `actions` (List.Item,
 * Grid.Item, Detail, Form) should render this alongside its own children.
 */
export function actionsSlot(actions: ReactNode | undefined): ReactElement | null {
  if (actions === undefined || actions === null) return null
  return createElement(NodeType.ActionsSlot, {}, actions)
}
