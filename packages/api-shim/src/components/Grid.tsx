import { createElement, type ReactElement, type ReactNode } from 'react'
import { NodeType } from '../node-types'
import { actionsSlot } from './host'
import { ListDropdown } from './List'
import { withFallbacks } from './namespace-fallback'

export interface GridItemProps {
  id?: string
  content: string | { source: string; tintColor?: string }
  title?: string
  subtitle?: string
  keywords?: string[]
  actions?: ReactNode
}
function GridItem(props: GridItemProps): ReactElement {
  const { actions, ...rest } = props
  return createElement(NodeType.GridItem, rest, actionsSlot(actions))
}

export interface GridSectionProps {
  title?: string
  subtitle?: string
  children?: ReactNode
}
function GridSection(props: GridSectionProps): ReactElement {
  const { children, ...rest } = props
  return createElement(NodeType.GridSection, rest, children)
}

export interface GridEmptyViewProps {
  title?: string
  description?: string
  icon?: string
  actions?: ReactNode
}
function GridEmptyView(props: GridEmptyViewProps): ReactElement {
  const { actions, ...rest } = props
  return createElement(NodeType.GridEmptyView, rest, actionsSlot(actions))
}

export interface GridProps {
  isLoading?: boolean
  columns?: number
  fit?: 'contain' | 'fill'
  aspectRatio?: string
  searchText?: string
  searchBarPlaceholder?: string
  onSearchTextChange?: (text: string) => void
  /** Explicitly asks the host to filter, even alongside
   *  `onSearchTextChange` — see `List`'s own `filtering`. */
  filtering?: boolean
  searchBarAccessory?: ReactNode
  navigationTitle?: string
  actions?: ReactNode
  children?: ReactNode
}

function GridBase(props: GridProps): ReactElement {
  const { children, searchBarAccessory, actions, ...rest } = props
  return createElement(NodeType.Grid, rest, searchBarAccessory ?? null, actionsSlot(actions), children)
}
/**
 * Raycast's sizing enums, which real extensions reference *while
 * rendering* — `fit={Grid.Fit.Fill}` is evaluated during the render pass,
 * so a missing enum is not a degraded grid but a `TypeError` that takes
 * the whole command down before it draws anything. Found exactly that way:
 * the `wikipedia` extension imported cleanly, built cleanly, and then
 * rendered nothing at all because `Grid.Fit` was undefined.
 *
 * The values are the strings Raycast uses, so an extension that stores or
 * compares them behaves the same here. The renderer does not vary layout
 * on them yet; carrying them keeps such extensions running until it does.
 */
GridBase.Fit = { Contain: 'contain', Fill: 'fill' } as const
GridBase.Inset = { Small: 'small', Medium: 'medium', Large: 'large' } as const
GridBase.ItemSize = { Small: 'small', Medium: 'medium', Large: 'large' } as const

GridBase.Item = GridItem
GridBase.Section = GridSection
GridBase.EmptyView = GridEmptyView
GridBase.Dropdown = ListDropdown

/**
 * A `Grid.*` member this shim doesn't implement renders nothing.
 *
 * Unlike `Form`, these namespaces have no inert visual slot — the
 * renderer collects `Grid.Item`/`Grid.Section` children by type, so an
 * unknown node would either be ignored anyway or disturb that collection.
 * Rendering `null` keeps the command mounting, which is the whole point.
 */
const gridWithFallbacks = withFallbacks(GridBase, () => {
  return (): null => null
})

/** The `Grid` extensions actually see. */
export const Grid = gridWithFallbacks
