import { createElement, type ReactElement, type ReactNode } from 'react'
import { NodeType } from '../node-types'
import { actionsSlot } from './host'
import { withFallbacks } from './namespace-fallback'

export interface DetailMetadataLabelProps {
  title: string
  text?: string
  icon?: string
}
function DetailMetadataLabel(props: DetailMetadataLabelProps): ReactElement {
  return createElement(NodeType.DetailMetadataLabel, props)
}

export interface DetailMetadataLinkProps {
  title: string
  target: string
  text: string
}
function DetailMetadataLink(props: DetailMetadataLinkProps): ReactElement {
  return createElement(NodeType.DetailMetadataLink, props)
}

export interface DetailMetadataTagListItemProps {
  text: string
  color?: string
  icon?: string
  onAction?: () => void
}
function DetailMetadataTagListItem(props: DetailMetadataTagListItemProps): ReactElement {
  return createElement(NodeType.DetailMetadataTagListItem, props)
}

export interface DetailMetadataTagListProps {
  title: string
  children?: ReactNode
}
function DetailMetadataTagList(props: DetailMetadataTagListProps): ReactElement {
  const { children, ...rest } = props
  return createElement(NodeType.DetailMetadataTagList, rest, children)
}
DetailMetadataTagList.Item = DetailMetadataTagListItem

function DetailMetadataSeparator(): ReactElement {
  return createElement(NodeType.DetailMetadataSeparator, {})
}

export interface DetailMetadataProps {
  children?: ReactNode
}
function DetailMetadata(props: DetailMetadataProps): ReactElement {
  const { children, ...rest } = props
  return createElement(NodeType.DetailMetadata, rest, children)
}
DetailMetadata.Label = DetailMetadataLabel
DetailMetadata.Link = DetailMetadataLink
DetailMetadata.TagList = DetailMetadataTagList
DetailMetadata.Separator = DetailMetadataSeparator

export interface DetailProps {
  markdown?: string
  navigationTitle?: string
  isLoading?: boolean
  actions?: ReactNode
  metadata?: ReactNode
}

function DetailBase(props: DetailProps): ReactElement {
  const { actions, metadata, ...rest } = props
  return createElement(NodeType.Detail, rest, actionsSlot(actions), metadata ?? null)
}
DetailBase.Metadata = DetailMetadata

/**
 * A `Detail.*` member this shim doesn't implement renders nothing.
 *
 * Unlike `Form`, these namespaces have no inert visual slot — the
 * renderer collects `Detail.Item`/`Detail.Section` children by type, so an
 * unknown node would either be ignored anyway or disturb that collection.
 * Rendering `null` keeps the command mounting, which is the whole point.
 */
const detailWithFallbacks = withFallbacks(DetailBase, () => {
  return (): null => null
})

/** The `Detail` extensions actually see. */
export const Detail = detailWithFallbacks
