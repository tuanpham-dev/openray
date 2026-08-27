import { useSyncExternalStore } from 'react'
import type { UiNode, UiTreeCommit } from '@openray/protocol'

export interface ExtensionTreeState {
  rootId: string | null
  nodes: Record<string, UiNode>
}

const EMPTY_STATE: ExtensionTreeState = { rootId: null, nodes: {} }

/**
 * Applies mount snapshots + diff ops from the extension host into a plain
 * node map, mirroring the same shape the reconciler (packages/api-shim)
 * tracks host-side.
 *
 * `reorder` is trusted as the *sole* mechanism that updates a parent's
 * `children` array — `insert`/`remove` only touch the node map itself.
 * This relies on an invariant the reconciler guarantees: any commit that
 * changes a parent's child set (add, remove, or move) always emits a
 * `reorder` for that parent in the same commit, with `reorder` ops always
 * last in the ops array (see reconciler.ts's flushCommit). That means by
 * the time a `reorder` is processed, every id it references has already
 * been inserted (or wasn't removed) earlier in the same commit.
 */
class ExtensionTreeStore {
  private state: ExtensionTreeState = EMPTY_STATE
  private listeners = new Set<() => void>()

  getState = (): ExtensionTreeState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private setState(next: ExtensionTreeState): void {
    this.state = next
    for (const listener of this.listeners) listener()
  }

  reset(): void {
    this.setState(EMPTY_STATE)
  }

  apply(commit: UiTreeCommit): void {
    if (commit.kind === 'snapshot') {
      this.setState({ rootId: commit.snapshot.rootId, nodes: { ...commit.snapshot.nodes } })
      return
    }

    const nodes = { ...this.state.nodes }
    for (const op of commit.ops) {
      if (op.op === 'insert') {
        nodes[op.node.id] = op.node
      } else if (op.op === 'remove') {
        delete nodes[op.id]
      } else if (op.op === 'updateProps') {
        const existing = nodes[op.id]
        if (existing) nodes[op.id] = { ...existing, props: op.props }
      } else if (op.op === 'reorder') {
        const parent = nodes[op.parentId]
        if (parent) nodes[op.parentId] = { ...parent, children: op.childIds }
      }
    }
    this.setState({ ...this.state, nodes })
  }
}

export const extensionTreeStore = new ExtensionTreeStore()

export function useExtensionTree(): ExtensionTreeState {
  return useSyncExternalStore(extensionTreeStore.subscribe, extensionTreeStore.getState)
}

/**
 * The tree's real root is always the synthetic `__root` node the
 * reconciler wraps every command in (see reconciler.ts's `mount` doc
 * comment) — this resolves past it to the extension's actual top-level
 * component (List/Detail/Grid/Form), which is what every renderer actually
 * wants to switch on.
 */
export function useExtensionRootNode(): UiNode | null {
  const { rootId, nodes } = useExtensionTree()
  if (!rootId) return null
  const root = nodes[rootId]
  if (!root) return null
  const topId = root.children[0]
  if (!topId) return null
  return nodes[topId] ?? null
}
