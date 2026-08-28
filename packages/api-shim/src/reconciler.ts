import ReactReconciler from 'react-reconciler'
import { DefaultEventPriority } from 'react-reconciler/constants'
import { createContext, createElement, type ReactElement } from 'react'
import type { JsonValue, UiDiffOp, UiNode, UiTreeCommit } from '@openray/protocol'
import { NavigationRoot, type NavigationController } from './hooks'
import { getCommandContext } from './api/command-context'

/**
 * The mutable, in-memory host tree. Mirrors `UiNode` from the protocol but
 * keeps live object references (parent/children) instead of an id-keyed map,
 * since react-reconciler's host config works with opaque instance handles.
 */
export interface HostNode {
  id: string
  type: string
  rawProps: Record<string, unknown>
  children: HostNode[]
  parent: HostNode | null
}

let nextNodeId = 0
function freshNodeId(): string {
  return `n${nextNodeId++}`
}

/** Reset id generation — test-only, so fixtures get deterministic ids. */
export function _resetNodeIdsForTests(): void {
  nextNodeId = 0
}

const callbacks = new Map<string, (...args: unknown[]) => unknown>()

function callbackKey(nodeId: string, propKey: string): string {
  return `${nodeId}:${propKey}`
}

/**
 * Registers a handler under a caller-chosen id.
 *
 * The UI tree keys callbacks by (nodeId, propKey), but toast actions have
 * no node — they're imperative. They register here so the frontend can
 * invoke them through the same `extension.invokeCallback` path as any
 * rendered handler, instead of a second callback mechanism.
 */
export function registerCallback(callbackId: string, fn: (...args: unknown[]) => unknown): void {
  callbacks.set(callbackId, fn)
}

export function unregisterCallback(callbackId: string): void {
  callbacks.delete(callbackId)
}

/** See the `createContainer` call site for why these must not re-throw. */
function reportReconcilerError(error: unknown): void {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
  process.stderr.write(`[api-shim] render error: ${detail}\n`)
}

export function invokeCallback(callbackId: string, args: unknown[]): unknown {
  const fn = callbacks.get(callbackId)
  if (!fn) throw new Error(`no callback registered for id "${callbackId}"`)
  return fn(...args)
}

function isPlainSerializable(value: unknown): boolean {
  if (value === null || value === undefined) return true
  const t = typeof value
  if (t === 'string' || t === 'number' || t === 'boolean') return true
  if (Array.isArray(value)) return value.every(isPlainSerializable)
  if (t === 'object') {
    // React elements and other class instances aren't plain data — skip them
    // defensively rather than shipping garbage over the wire.
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) return false
    return Object.values(value as Record<string, unknown>).every(isPlainSerializable)
  }
  return false
}

/**
 * Converts a node's raw React props into wire-safe JSON. Functions become a
 * `{ __callback: id }` marker keyed by (nodeId, propKey) — not by function
 * identity, since inline arrow props get a new identity every render;
 * keying by slot means re-renders just overwrite the same registry entry
 * instead of leaking a new id each render. `children` and `actions` are
 * handled as host children by the component layer, never as props.
 */
/**
 * Props naming a file that belongs to the extension. Kept to an explicit
 * list so nothing else — a markdown body, a title — is ever mistaken for a
 * path.
 */
const ASSET_PROP_KEYS = new Set(['icon', 'source', 'image', 'thumbnail'])

/**
 * Turns a relative asset path into an absolute one.
 *
 * Extensions reference their own files the way Raycast documents it —
 * `icon={{ source: "../assets/wikipedia.png" }}` — which is relative to the
 * compiled command, not to anything the renderer knows about. Sent as-is it
 * matches neither an absolute path nor a built-in icon name, so it was
 * drawn as literal text: rows in `wikipedia` showed "../a" where the page
 * thumbnail belonged.
 *
 * A *bare* name counts too: `Image.Asset` is documented as "a string
 * denoting an asset from the `assets/` folder", and extensions write it
 * without any prefix — `icon={{ source: "body-style/8.png" }}` in
 * `pokedex`, whose Shape row rendered that string as literal text. A name
 * only qualifies when it carries a file extension, so built-in icon names
 * (`trash`, `arrow-up-circle`) are never mistaken for files.
 *
 * Resolved here, at the one point every prop crosses to the renderer, using
 * the command context's own `assetsPath`.
 */
const RELATIVE_FILE = /^[^/\\][^:]*\.[a-z0-9]{2,4}$/i

function resolveAssetPath(value: unknown): unknown {
  if (typeof value === 'string') {
    const relative = value.startsWith('./') || value.startsWith('../') || RELATIVE_FILE.test(value)
    if (!relative) return value
    let assetsPath: string
    try {
      assetsPath = getCommandContext().assetsPath
    } catch {
      return value
    }
    if (!assetsPath) return value
    // `assetsPath` *is* the assets directory, so a "../assets/x" written
    // relative to the build output resolves to "x" within it.
    const file = value.replace(/^\.\.?\//, '').replace(/^assets\//, '')
    return `${assetsPath.replace(/\/$/, '')}/${file}`
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    if (typeof record.source === 'string') {
      return { ...record, source: resolveAssetPath(record.source) }
    }
  }
  return value
}

function serializeProps(nodeId: string, rawProps: Record<string, unknown>): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {}
  for (const [key, value] of Object.entries(rawProps)) {
    if (key === 'children' || key === 'actions') continue
    if (value === undefined) continue
    if (typeof value === 'function') {
      const id = callbackKey(nodeId, key)
      callbacks.set(id, value as (...args: unknown[]) => unknown)
      out[key] = { __callback: id }
      continue
    }
    if (!isPlainSerializable(value)) continue
    out[key] = (ASSET_PROP_KEYS.has(key) ? resolveAssetPath(value) : value) as JsonValue
  }
  return out
}

function clearCallbacksFor(nodeId: string): void {
  const prefix = `${nodeId}:`
  for (const key of callbacks.keys()) {
    if (key.startsWith(prefix)) callbacks.delete(key)
  }
}

function toUiNode(node: HostNode): UiNode {
  return {
    id: node.id,
    type: node.type,
    props: serializeProps(node.id, node.rawProps),
    children: node.children.map((c) => c.id),
  }
}

function snapshotFrom(root: HostNode): UiTreeCommit {
  const nodes: Record<string, UiNode> = {}
  const walk = (n: HostNode) => {
    nodes[n.id] = toUiNode(n)
    n.children.forEach(walk)
  }
  walk(root)
  return { kind: 'snapshot', snapshot: { rootId: root.id, nodes } }
}

interface CommitState {
  removedOps: UiDiffOp[]
  dirtyParents: Set<HostNode>
  updatedProps: Map<string, HostNode>
}

interface HostState {
  commit: CommitState | null
  knownNodeIds: Set<string>
  lastOrder: Map<string, string[]>
  lastSentProps: Map<string, string>
}

type Timeout = ReturnType<typeof setTimeout>
type NoTimeoutValue = -1
const NO_TIMEOUT: NoTimeoutValue = -1

type Config = ReactReconciler.HostConfig<
  string, // Type
  Record<string, unknown>, // Props
  HostNode, // Container
  HostNode, // Instance
  HostNode, // TextInstance
  HostNode, // SuspenseInstance
  HostNode, // HydratableInstance
  HostNode, // FormInstance
  HostNode, // PublicInstance
  object, // HostContext
  never, // ChildSet (persistence mode only)
  Timeout, // TimeoutHandle
  NoTimeoutValue, // NoTimeout
  null // TransitionStatus
>

function makeHostConfig(state: HostState): Config {
  function currentCommit(): CommitState {
    if (!state.commit) throw new Error('host config mutation called outside a commit')
    return state.commit
  }

  function removeSubtree(node: HostNode, commit: CommitState): void {
    clearCallbacksFor(node.id)
    state.knownNodeIds.delete(node.id)
    commit.removedOps.push({ op: 'remove', id: node.id })
    for (const child of node.children) removeSubtree(child, commit)
  }

  function attach(parent: HostNode, child: HostNode): void {
    // Mirrors DOM appendChild semantics: always moves the child to the end
    // of the parent's children, even if it's already there — react-reconciler
    // relies on this to reposition existing children during array
    // reconciliation, not just to attach brand-new ones.
    const existingIndex = parent.children.indexOf(child)
    if (existingIndex !== -1) parent.children.splice(existingIndex, 1)
    parent.children.push(child)
    child.parent = parent
    currentCommit().dirtyParents.add(parent)
  }

  function attachBefore(parent: HostNode, child: HostNode, beforeChild: HostNode): void {
    const existingIndex = parent.children.indexOf(child)
    if (existingIndex !== -1) parent.children.splice(existingIndex, 1)
    const beforeIndex = parent.children.indexOf(beforeChild)
    parent.children.splice(beforeIndex === -1 ? parent.children.length : beforeIndex, 0, child)
    child.parent = parent
    currentCommit().dirtyParents.add(parent)
  }

  function detach(parent: HostNode, child: HostNode): void {
    const index = parent.children.indexOf(child)
    if (index !== -1) parent.children.splice(index, 1)
    currentCommit().dirtyParents.add(parent)
    removeSubtree(child, currentCommit())
  }

  return {
    supportsMutation: true,
    supportsPersistence: false,
    supportsHydration: false,
    isPrimaryRenderer: true,

    scheduleTimeout: setTimeout,
    cancelTimeout: clearTimeout,
    noTimeout: NO_TIMEOUT,

    getRootHostContext: () => ({}),
    getChildHostContext: (parentContext: object) => parentContext,
    shouldSetTextContent: () => false,

    createInstance(type: string, props: Record<string, unknown>): HostNode {
      return { id: freshNodeId(), type, rawProps: props, children: [], parent: null }
    },

    createTextInstance(): HostNode {
      // Raycast components take content via props (title, markdown, ...),
      // never raw JSX text children — if this fires, an extension used a
      // pattern we don't support (e.g. `<Detail>some text</Detail>`).
      throw new Error('Text children are not supported — pass content via props instead (e.g. title, markdown)')
    },

    appendInitialChild(parent: HostNode, child: HostNode) {
      child.parent = parent
      parent.children.push(child)
    },

    finalizeInitialChildren: () => false,
    commitMount: () => {},

    appendChildToContainer(container: HostNode, child: HostNode) {
      attach(container, child)
    },
    appendChild(parent: HostNode, child: HostNode) {
      attach(parent, child)
    },
    insertBefore(parent: HostNode, child: HostNode, beforeChild: HostNode) {
      attachBefore(parent, child, beforeChild)
    },
    insertInContainerBefore(container: HostNode, child: HostNode, beforeChild: HostNode) {
      attachBefore(container, child, beforeChild)
    },
    removeChild(parent: HostNode, child: HostNode) {
      detach(parent, child)
    },
    removeChildFromContainer(container: HostNode, child: HostNode) {
      detach(container, child)
    },

    commitUpdate(instance: HostNode, _type: string, prevProps: Record<string, unknown>, nextProps: Record<string, unknown>) {
      if (prevProps === nextProps) return
      instance.rawProps = nextProps
      currentCommit().updatedProps.set(instance.id, instance)
    },

    commitTextUpdate: () => {},
    clearContainer: () => {},
    preparePortalMount: () => {},
    getPublicInstance: (instance: HostNode) => instance,
    prepareForCommit: () => null,
    resetAfterCommit: () => {},
    getInstanceFromNode: () => null,
    beforeActiveInstanceBlur: () => {},
    afterActiveInstanceBlur: () => {},
    prepareScopeUpdate: () => {},
    getInstanceFromScope: () => null,
    detachDeletedInstance: () => {},
    getCurrentUpdatePriority: () => DefaultEventPriority,
    resolveUpdatePriority: () => DefaultEventPriority,
    setCurrentUpdatePriority: () => {},
    maySuspendCommit: () => false,

    // React 19 concurrent-features surface this renderer doesn't use
    // (no transitions/suspense/forms driving host-level scheduling here).
    NotPendingTransition: null,
    HostTransitionContext: createContext<null>(null) as unknown as ReactReconciler.ReactContext<null>,
    resetFormInstance: () => {},
    requestPostPaintCallback: () => {},
    shouldAttemptEagerTransition: () => false,
    trackSchedulerEvent: () => {},
    resolveEventType: () => null,
    resolveEventTimeStamp: () => -1.1,
    preloadInstance: () => true,
    startSuspendingCommit: () => {},
    suspendInstance: () => {},
    waitForCommitToBeReady: () => null,
  }
}

export interface MountHandle {
  /** Force a full snapshot of the current tree — e.g. after a detected desync. */
  resync: () => UiTreeCommit
  unmount: () => void
  rootId: string
  /** Pops this tree's own navigation stack one level (false when it's
   *  already showing the command's initial view) — how the host's back
   *  button and Escape undo an `Action.Push`. */
  popNavigation: () => boolean
}

/**
 * The snapshot's `rootId` always points at a synthetic `type: '__root'`
 * node, never directly at the extension's top-level component (List/Detail/
 * Grid/Form). Renderers should treat `__root` as a transparent container —
 * render its children with no chrome of its own. This is deliberate, not an
 * oversight: a command can swap its top-level type at runtime (e.g. render
 * `<List>` then later `<Detail>`), which needs a stable `parentId` for the
 * insert/remove ops on that swap; omitting `__root` when there's exactly
 * one child would leave the diff's `parentId` referencing a node the
 * snapshot never actually sent.
 */
export function mount(element: ReactElement, onCommit: (commit: UiTreeCommit) => void): MountHandle {
  const rootNode: HostNode = { id: freshNodeId(), type: '__root', rawProps: {}, children: [], parent: null }
  const state: HostState = { commit: null, knownNodeIds: new Set(), lastOrder: new Map(), lastSentProps: new Map() }
  const hostConfig = makeHostConfig(state)

  let hasMounted = false

  function markAllKnown(node: HostNode): void {
    state.knownNodeIds.add(node.id)
    state.lastOrder.set(
      node.id,
      node.children.map((c) => c.id),
    )
    state.lastSentProps.set(node.id, JSON.stringify(serializeProps(node.id, node.rawProps)))
    node.children.forEach(markAllKnown)
  }

  function arraysEqual(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((v, i) => v === b[i])
  }

  /**
   * Pre-order walk collecting nodes not yet in `state.knownNodeIds`.
   *
   * Deliberately NOT driven by the `attach`/`attachBefore` host-config
   * calls (which is how insert-detection used to work): react-reconciler
   * builds a brand-new subtree off-screen via `appendInitialChild` (no
   * dirty-tracking there — it's pre-mount construction, not a mutation)
   * and only attaches the subtree's *root* to the live tree via a single
   * `appendChild`/`insertBefore` call. That meant a pushed view with any
   * nested structure (e.g. Detail > __actions > ActionPanel > Action) only
   * ever emitted an `insert` for the top node — its descendants were
   * referenced in `children` but never sent, silently breaking any
   * consumer that resolves ids against what it's actually received.
   * Walking the whole tree for "not yet known" is correct regardless of
   * which host-config call attached a node.
   */
  function collectUnknownNodes(root: HostNode, known: Set<string>, out: HostNode[]): void {
    if (!known.has(root.id)) out.push(root)
    for (const child of root.children) collectUnknownNodes(child, known, out)
  }

  function flushCommit(commit: CommitState): void {
    if (!hasMounted) {
      hasMounted = true
      markAllKnown(rootNode)
      onCommit(snapshotFrom(rootNode))
      return
    }

    const ops: UiDiffOp[] = []
    const newlyInserted = new Set<string>()

    const unknown: HostNode[] = []
    collectUnknownNodes(rootNode, state.knownNodeIds, unknown)
    for (const node of unknown) {
      if (!node.parent) continue // rootNode itself, or an orphaned/discarded node
      const index = node.parent.children.indexOf(node)
      const uiNode = toUiNode(node)
      ops.push({ op: 'insert', node: uiNode, parentId: node.parent.id, index })
      state.knownNodeIds.add(node.id)
      state.lastSentProps.set(node.id, JSON.stringify(uiNode.props))
      newlyInserted.add(node.id)
    }

    ops.push(...commit.removedOps)
    for (const removed of commit.removedOps) {
      if (removed.op === 'remove') state.lastSentProps.delete(removed.id)
    }

    for (const node of commit.updatedProps.values()) {
      if (newlyInserted.has(node.id)) continue // already carries full props via insert
      const props = serializeProps(node.id, node.rawProps)
      const serialized = JSON.stringify(props)
      // commitUpdate fires whenever the props *object reference* changes,
      // which is every render — not whenever the serialized wire value
      // actually differs. Only emit when it genuinely does.
      if (state.lastSentProps.get(node.id) === serialized) continue
      state.lastSentProps.set(node.id, serialized)
      ops.push({ op: 'updateProps', id: node.id, props })
    }

    for (const parent of commit.dirtyParents) {
      const currentOrder = parent.children.map((c) => c.id)
      const previousOrder = state.lastOrder.get(parent.id)
      if (!previousOrder || !arraysEqual(previousOrder, currentOrder)) {
        ops.push({ op: 'reorder', parentId: parent.id, childIds: currentOrder })
        state.lastOrder.set(parent.id, currentOrder)
      }
    }

    if (ops.length > 0) onCommit({ kind: 'diff', ops })
  }

  hostConfig.prepareForCommit = () => {
    state.commit = { removedOps: [], dirtyParents: new Set(), updatedProps: new Map() }
    return null
  }
  hostConfig.resetAfterCommit = () => {
    const commit = state.commit
    state.commit = null
    if (commit) flushCommit(commit)
  }

  const Reconciler = ReactReconciler(hostConfig)
  const container = Reconciler.createContainer(
    rootNode,
    0, // LegacyRoot — synchronous commits, no Suspense/transitions needed here
    null,
    false,
    null,
    '',
    // onUncaughtError / onCaughtError / onRecoverableError.
    //
    // These *report* an error React has already handled; they are called
    // from inside render and commit. Throwing from one re-throws into the
    // reconciler's own machinery and leaves it mid-work, so every later
    // update dies with "Should not already be working" — one bad render
    // permanently wedges the command instead of failing that render.
    //
    // Reported to stderr, which the host forwards as an extension log
    // line, so the failure is visible without being fatal.
    reportReconcilerError,
    reportReconcilerError,
    reportReconcilerError,
    () => {},
  )

  // Filled in by NavigationRoot's own render; the placeholder answers
  // "nothing to pop" for the window between mount and first commit.
  const navigation: NavigationController = { pop: () => false }
  Reconciler.updateContainer(createElement(NavigationRoot, { initial: element, controller: navigation }), container, null, () => {})

  return {
    rootId: rootNode.id,
    resync: () => snapshotFrom(rootNode),
    popNavigation: () => navigation.pop(),
    unmount: () => {
      Reconciler.updateContainer(null, container, null, () => {})
    },
  }
}
