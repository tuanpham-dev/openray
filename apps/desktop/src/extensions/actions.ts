import type { UiNode } from '@openray/protocol'
import type { PaletteAction } from '../state/actions'
import type { CommandArgument } from '../components/types'
import { invokeExtensionCallback } from '../ipc/extensionHost'
import { resolveVisual } from './resolveVisual'

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

/** Keys with a conventional symbol; anything else shows its own letter. */
const KEY_SYMBOLS: Record<string, string> = {
  enter: '↵',
  return: '↵',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  backspace: '⌫',
  delete: '⌦',
  escape: '⎋',
  tab: '⇥',
  space: '␣',
}

function shortcutLabel(shortcut: unknown): string | undefined {
  const parsed = parseShortcut(shortcut)
  if (!parsed) return undefined
  const mods = parsed.modifiers.map((m) => MODIFIER_SYMBOLS[m] ?? m).join('')
  return `${mods}${KEY_SYMBOLS[parsed.key] ?? parsed.key.toUpperCase()}`
}

export interface ParsedShortcut {
  modifiers: string[]
  /** Lower-cased, so callers can compare against `KeyboardEvent.key`. */
  key: string
}

/** The `{ modifiers, key }` an extension declares, normalized. Exported so
 *  a view can match a real keypress against it, not just print it. */
export function parseShortcut(shortcut: unknown): ParsedShortcut | null {
  if (!shortcut || typeof shortcut !== 'object') return null
  const { modifiers, key } = shortcut as { modifiers?: unknown; key?: unknown }
  if (typeof key !== 'string' || !key) return null
  const list = Array.isArray(modifiers) ? modifiers.filter((m): m is string => typeof m === 'string') : []
  return { modifiers: list, key: key.toLowerCase() }
}

/**
 * Whether a keypress is the one this shortcut names.
 *
 * Extensions are written on macOS, where the primary accelerator is ⌘ and
 * Control is a *separate* modifier — Raycast's own Create Extension uses
 * ⌘↵, ⌘⇧↵, ⌘⌃↵ and ⌘⌥↵ as four distinct shortcuts. Linux has no ⌘, so:
 *
 * - `cmd` alone matches Ctrl (or Meta, for anyone whose muscle memory
 *   says so), but *not* both at once;
 * - `cmd` + `ctrl` together needs both — Ctrl and Super. Folding them onto
 *   plain Ctrl instead made ⌘⌃↵ indistinguishable from ⌘↵, so whichever
 *   action came first in the panel swallowed the other's keypress.
 */
export function matchesShortcut(event: KeyboardEvent, shortcut: ParsedShortcut): boolean {
  if (event.key.toLowerCase() !== shortcut.key) return false
  const wanted = new Set(shortcut.modifiers)

  const wantsPrimary = wanted.has('cmd') || wanted.has('meta')
  const wantsControl = wanted.has('ctrl') || wanted.has('control')
  const both = event.ctrlKey && event.metaKey
  const either = event.ctrlKey || event.metaKey
  if (wantsPrimary && wantsControl) {
    if (!both) return false
  } else if (wantsPrimary || wantsControl) {
    if (!either || both) return false
  } else if (either) {
    return false
  }

  if (wanted.has('shift') !== event.shiftKey) return false
  if ((wanted.has('opt') || wanted.has('alt') || wanted.has('option')) !== event.altKey) return false
  return true
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
/** An `Action`'s declared inline arguments, normalised to the shape
 *  `ArgumentFields` already renders for a command's own arguments — so an
 *  extension's action gets the identical search-bar treatment rather than a
 *  second, parallel prompt. Anything malformed is dropped rather than
 *  rendered as a nameless field. */
function argumentsFrom(prop: unknown): CommandArgument[] | undefined {
  if (!Array.isArray(prop)) return undefined
  const declared = prop.flatMap((entry): CommandArgument[] => {
    if (!entry || typeof entry !== 'object') return []
    const { name, type, placeholder, required } = entry as Record<string, unknown>
    if (typeof name !== 'string' || name === '') return []
    return [
      {
        name,
        type: type === 'password' ? 'password' : 'text',
        placeholder: typeof placeholder === 'string' ? placeholder : null,
        // An action that asks for a value normally cannot run without one.
        required: required !== false,
      },
    ]
  })
  return declared.length > 0 ? declared : undefined
}

export function actionsFromSlot(slot: UiNode | undefined, nodes: Record<string, UiNode>): PaletteAction[] {
  if (!slot) return []
  const actions: PaletteAction[] = []

  function walk(id: string): void {
    const node = nodes[id]
    if (!node) return
    if (node.type === 'Action') {
      const callbackId = callbackIdFrom(node.props.onAction)
      const declared = argumentsFrom(node.props.arguments)
      actions.push({
        id: node.id,
        title: typeof node.props.title === 'string' ? node.props.title : 'Action',
        // An action's icon takes the same `Image.ImageLike` union a list
        // row's does, so `{ source }` / `{ source: { light, dark } }` has
        // to be flattened here — reading only the string form dropped
        // those icons silently.
        icon: resolveVisual(node.props.icon).source || undefined,
        shortcut: shortcutLabel(node.props.shortcut),
        arguments: declared,
        // The collected values are only passed on when the action asked for
        // them, so an action taking none keeps being called with no
        // arguments at all.
        onAction: (values) =>
          callbackId ? invokeExtensionCallback(callbackId, declared ? [values ?? {}] : []) : Promise.resolve(),
      })
      return
    }
    // ActionPanel / ActionPanel.Section / __actions: transparent containers, recurse.
    for (const childId of node.children) walk(childId)
  }

  walk(slot.id)
  return actions
}
