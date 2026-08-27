import { createElement, type ReactElement, type ReactNode } from 'react'
import { NodeType } from '../node-types'
import { actionsSlot } from './host'
import { ListDropdown } from './List'

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
  searchBarAccessory?: ReactNode
  navigationTitle?: string
  actions?: ReactNode
  children?: ReactNode
}

export function Grid(props: GridProps): ReactElement {
  const { children, searchBarAccessory, actions, ...rest } = props
  return createElement(NodeType.Grid, rest, searchBarAccessory ?? null, actionsSlot(actions), children)
}
Grid.Item = GridItem
Grid.Section = GridSection
Grid.EmptyView = GridEmptyView
Grid.Dropdown = ListDropdown
