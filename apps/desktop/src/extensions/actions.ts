import type { UiNode } from '@openray/protocol'
import type { PaletteAction } from '../state/actions'
import { invokeExtensionCallback } from '../ipc/extensionHost'

function callbackIdFrom(prop: unknown): string | null {
  if (prop && typeof prop === 'object' && '__callback' in (prop as Record<string, unknown>)) {
    return (prop as { __callback: string }).__callback
  }
  return null
}

const MODIFIER_SYMBOLS: Record<string, string> = {
  cmd: '⌘',
  meta: '⌘',
  ctrl: '⌃',
  control: '⌃',
  shift: '⇧',
  opt: '⌥',
  alt: '⌥',
  option: '⌥',
}

function shortcutLabel(shortcut: unknown): string | undefined {
  if (!shortcut || typeof shortcut !== 'object') return undefined
  const { modifiers, key } = shortcut as { modifiers?: string[]; key?: string }
  if (!key) return undefined
  const mods = (modifiers ?? []).map((m) => MODIFIER_SYMBOLS[m] ?? m).join('')
  return `${mods}${key.toUpperCase()}`
}

/** The `__actions` node wraps a component's `actions` prop — see reconciler.ts. */
export function findActionsSlot(node: UiNode | undefined, nodes: Record<string, UiNode>): UiNode | undefined {
  if (!node) return undefined
  for (const childId of node.children) {
    const child = nodes[childId]
    if (child?.type === '__actions') return child
  }
  return undefined
}

/**
 * Flattens an `__actions` subtree (ActionPanel > [Section >] Action, or a
 * bare Action) into the same PaletteAction shape apps/desktop's own
 * ActionPanel/ActionItem components already render for built-in commands —
 * reused as-is rather than forked, per the plan's shared-component-library
 * constraint.
 */
export function actionsFromSlot(slot: UiNode | undefined, nodes: Record<string, UiNode>): PaletteAction[] {
  if (!slot) return []
  const actions: PaletteAction[] = []

  function walk(id: string): void {
    const node = nodes[id]
    if (!node) return
    if (node.type === 'Action') {
      const callbackId = callbackIdFrom(node.props.onAction)
      actions.push({
        id: node.id,
        title: typeof node.props.title === 'string' ? node.props.title : 'Action',
        icon: typeof node.props.icon === 'string' ? node.props.icon : undefined,
        shortcut: shortcutLabel(node.props.shortcut),
        onAction: () => (callbackId ? invokeExtensionCallback(callbackId) : Promise.resolve()),
      })
      return
    }
    // ActionPanel / ActionPanel.Section / __actions: transparent containers, recurse.
    for (const childId of node.children) walk(childId)
  }

  walk(slot.id)
  return actions
}
