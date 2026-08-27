import type { JsonValue } from './rpc'

export type NodeId = string

export interface UiNode {
  id: NodeId
  type: string
  props: Record<string, JsonValue>
  children: NodeId[]
}

export interface UiTreeSnapshot {
  rootId: NodeId
  nodes: Record<NodeId, UiNode>
}

export interface InsertOp {
  op: 'insert'
  node: UiNode
  parentId: NodeId
  index: number
}

export interface RemoveOp {
  op: 'remove'
  id: NodeId
}

export interface ReorderOp {
  op: 'reorder'
  parentId: NodeId
  childIds: NodeId[]
}

export interface UpdatePropsOp {
  op: 'updateProps'
  id: NodeId
  props: Record<string, JsonValue>
}

export type UiDiffOp = InsertOp | RemoveOp | ReorderOp | UpdatePropsOp

export type UiTreeCommit = { kind: 'snapshot'; snapshot: UiTreeSnapshot } | { kind: 'diff'; ops: UiDiffOp[] }
