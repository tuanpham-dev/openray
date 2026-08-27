/**
 * Single-persistent-window management for the AI extension's two window
 * kinds (Chat, Command Run) — same `globalThis`-anchored pattern
 * `extensions/notes/src/window.tsx` established (T26): each command is
 * its own esbuild bundle, so a plain module-level variable here would be
 * a *different* variable per bundle; anchoring on `globalThis` makes it
 * shared across every command's copy of this module, all inside the same
 * long-lived Node sidecar process.
 */
import type { ReactElement } from 'react'
import { openExtensionWindow } from '@openray/extras'

interface WindowSlot {
  handle: { close(): void; focus(): void } | null
}

function slot(key: string): WindowSlot {
  const g = globalThis as Record<string, unknown>
  const slotKey = `__aiWindow_${key}`
  if (!g[slotKey]) g[slotKey] = { handle: null } satisfies WindowSlot
  return g[slotKey] as WindowSlot
}

/** Opens `key`'s window if none is open, otherwise focuses the existing
 *  one. `render` is only called on a fresh open — an already-open window
 *  keeps whatever tree it already has (the caller updates it via its own
 *  state, same as `NotesWindowView`'s `useSyncExternalStore` pattern). */
export async function openOrFocusWindow(key: string, render: () => ReactElement, options: { title: string; width: number; height: number }): Promise<void> {
  const s = slot(key)
  if (s.handle) {
    s.handle.focus()
    return
  }
  s.handle = await openExtensionWindow(render(), {
    title: options.title,
    decorations: false,
    width: options.width,
    height: options.height,
    onClose: () => {
      s.handle = null
    },
  })
}

export function isWindowOpen(key: string): boolean {
  return slot(key).handle !== null
}

/** A tiny `globalThis`-anchored reactive value, so a later
 *  `openOrFocusWindow` call that reuses an already-open window can still
 *  redirect its content (e.g. "New Chat with Agent X" while the Chat
 *  window is already open) — same role `NotesWindowView`'s
 *  `useSyncExternalStore` plays for the Notes window. */
export function createReactiveSlot<T>(key: string, initial: T): { get: () => T; set: (value: T) => void; subscribe: (listener: () => void) => () => void } {
  const g = globalThis as Record<string, unknown>
  const slotKey = `__aiReactiveSlot_${key}`
  if (!g[slotKey]) {
    g[slotKey] = { value: initial, listeners: new Set<() => void>() }
  }
  const state = g[slotKey] as { value: T; listeners: Set<() => void> }
  return {
    get: () => state.value,
    set: (value: T) => {
      state.value = value
      state.listeners.forEach((listener) => listener())
    },
    subscribe: (listener: () => void) => {
      state.listeners.add(listener)
      return () => state.listeners.delete(listener)
    },
  }
}
