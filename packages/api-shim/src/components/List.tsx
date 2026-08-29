import { createElement, type ReactElement, type ReactNode } from 'react'
import { NodeType } from '../node-types'
import { actionsSlot } from './host'
import { Detail } from './Detail'
import { withFallbacks } from './namespace-fallback'

export interface ListItemAccessory {
  text?: string | { value: string; color?: string }
  icon?: string
  date?: string
  tag?: string | { value: string; color?: string }
  tooltip?: string
}

export interface ListItemProps {
  id?: string
  title: string | { value: string; tooltip?: string }
  subtitle?: string | { value: string; tooltip?: string }
  icon?: string | { source: string; tintColor?: string }
  accessories?: ListItemAccessory[]
  keywords?: string[]
  actions?: ReactNode
  detail?: ReactNode
}

function ListItem(props: ListItemProps): ReactElement {
  const { actions, detail, ...rest } = props
  return createElement(NodeType.ListItem, rest, actionsSlot(actions), detail ?? null)
}
/** Same shape as the standalone `Detail` — reused as-is (not a distinct
 *  node type) so `TreeRenderer.tsx`'s existing markdown+metadata rendering
 *  works unchanged whether `Detail` is a full-window view or nested here
 *  as a `List.Item`'s split-pane preview. */
ListItem.Detail = Detail

export interface ListSectionProps {
  title?: string
  subtitle?: string
  children?: ReactNode
}

function ListSection(props: ListSectionProps): ReactElement {
  const { children, ...rest } = props
  return createElement(NodeType.ListSection, rest, children)
}

export interface ListEmptyViewProps {
  title?: string
  description?: string
  icon?: string
  actions?: ReactNode
}

function ListEmptyView(props: ListEmptyViewProps): ReactElement {
  const { actions, ...rest } = props
  return createElement(NodeType.ListEmptyView, rest, actionsSlot(actions))
}

export interface ListDropdownItemProps {
  title: string
  value: string
  icon?: string
}

function ListDropdownItem(props: ListDropdownItemProps): ReactElement {
  return createElement(NodeType.ListDropdownItem, props)
}

export interface ListDropdownSectionProps {
  title?: string
  children?: ReactNode
}

function ListDropdownSection(props: ListDropdownSectionProps): ReactElement {
  const { children, ...rest } = props
  return createElement(NodeType.ListDropdownSection, rest, children)
}

export interface ListDropdownProps {
  tooltip?: string
  placeholder?: string
  storeValue?: boolean
  defaultValue?: string
  value?: string
  onChange?: (value: string) => void
  children?: ReactNode
}

export function ListDropdown(props: ListDropdownProps): ReactElement {
  const { children, ...rest } = props
  return createElement(NodeType.ListDropdown, rest, children)
}
ListDropdown.Item = ListDropdownItem
ListDropdown.Section = ListDropdownSection

export interface ListProps {
  isLoading?: boolean
  searchText?: string
  searchBarPlaceholder?: string
  onSearchTextChange?: (text: string) => void
  throttle?: boolean
  filtering?: boolean
  navigationTitle?: string
  searchBarAccessory?: ReactNode
  selectedItemId?: string
  onSelectionChange?: (id: string | null) => void
  actions?: ReactNode
  children?: ReactNode
}

function ListBase(props: ListProps): ReactElement {
  const { children, searchBarAccessory, actions, ...rest } = props
  return createElement(NodeType.List, rest, searchBarAccessory ?? null, actionsSlot(actions), children)
}
ListBase.Item = ListItem
ListBase.Section = ListSection
ListBase.EmptyView = ListEmptyView
ListBase.Dropdown = ListDropdown

/**
 * A `List.*` member this shim doesn't implement renders nothing.
 *
 * Unlike `Form`, these namespaces have no inert visual slot — the
 * renderer collects `List.Item`/`List.Section` children by type, so an
 * unknown node would either be ignored anyway or disturb that collection.
 * Rendering `null` keeps the command mounting, which is the whole point.
 */
const listWithFallbacks = withFallbacks(ListBase, () => {
  return (): null => null
})

/** The `List` extensions actually see. */
export const List = listWithFallbacks
