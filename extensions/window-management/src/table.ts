import type { WindowAction } from '@openray/window-layout'

// Ported from src-tauri/src/application/window_management/mod.rs's
// `table()`. Ids are bare (no `window.` prefix, unlike the native ids) —
// Rust re-namespaces every root-provider row as `ext:window-management:{id}`
// automatically, the same convention T17's system-commands port used.

export type PresetKind =
  | { type: 'frame'; action: WindowAction }
  | { type: 'restore' }
  | { type: 'toggle-fullscreen' }
  | { type: 'next-display' }
  | { type: 'previous-display' }

export interface PresetEntry {
  id: string
  title: string
  icon: string
  keywords: string[]
  kind: PresetKind
}

function frame(action: WindowAction): PresetKind {
  return { type: 'frame', action }
}

export const TABLE: PresetEntry[] = [
  { id: 'left-half', title: 'Left Half', icon: 'window-left-half', keywords: ['left', 'half', 'tile'], kind: frame({ kind: 'half', half: 'left' }) },
  { id: 'right-half', title: 'Right Half', icon: 'window-right-half', keywords: ['right', 'half', 'tile'], kind: frame({ kind: 'half', half: 'right' }) },
  { id: 'top-half', title: 'Top Half', icon: 'window-top-half', keywords: ['top', 'half', 'tile'], kind: frame({ kind: 'half', half: 'top' }) },
  { id: 'bottom-half', title: 'Bottom Half', icon: 'window-bottom-half', keywords: ['bottom', 'half', 'tile'], kind: frame({ kind: 'half', half: 'bottom' }) },
  { id: 'top-left-quarter', title: 'Top Left Quarter', icon: 'window-quarter', keywords: ['quarter', 'tile'], kind: frame({ kind: 'quarter', quarter: 'top-left' }) },
  { id: 'top-right-quarter', title: 'Top Right Quarter', icon: 'window-quarter', keywords: ['quarter', 'tile'], kind: frame({ kind: 'quarter', quarter: 'top-right' }) },
  { id: 'bottom-left-quarter', title: 'Bottom Left Quarter', icon: 'window-quarter', keywords: ['quarter', 'tile'], kind: frame({ kind: 'quarter', quarter: 'bottom-left' }) },
  { id: 'bottom-right-quarter', title: 'Bottom Right Quarter', icon: 'window-quarter', keywords: ['quarter', 'tile'], kind: frame({ kind: 'quarter', quarter: 'bottom-right' }) },
  { id: 'top-left-sixth', title: 'Top Left Sixth', icon: 'window-sixth', keywords: ['sixth', 'tile'], kind: frame({ kind: 'sixth', sixth: 'top-left' }) },
  { id: 'top-center-sixth', title: 'Top Center Sixth', icon: 'window-sixth', keywords: ['sixth', 'tile'], kind: frame({ kind: 'sixth', sixth: 'top-center' }) },
  { id: 'top-right-sixth', title: 'Top Right Sixth', icon: 'window-sixth', keywords: ['sixth', 'tile'], kind: frame({ kind: 'sixth', sixth: 'top-right' }) },
  { id: 'bottom-left-sixth', title: 'Bottom Left Sixth', icon: 'window-sixth', keywords: ['sixth', 'tile'], kind: frame({ kind: 'sixth', sixth: 'bottom-left' }) },
  { id: 'bottom-center-sixth', title: 'Bottom Center Sixth', icon: 'window-sixth', keywords: ['sixth', 'tile'], kind: frame({ kind: 'sixth', sixth: 'bottom-center' }) },
  { id: 'bottom-right-sixth', title: 'Bottom Right Sixth', icon: 'window-sixth', keywords: ['sixth', 'tile'], kind: frame({ kind: 'sixth', sixth: 'bottom-right' }) },
  { id: 'first-third', title: 'First Third', icon: 'window-third', keywords: ['third', 'tile'], kind: frame({ kind: 'third', third: 'first' }) },
  { id: 'center-third', title: 'Center Third', icon: 'window-third', keywords: ['third', 'tile'], kind: frame({ kind: 'third', third: 'center' }) },
  { id: 'last-third', title: 'Last Third', icon: 'window-third', keywords: ['third', 'tile'], kind: frame({ kind: 'third', third: 'last' }) },
  { id: 'first-two-thirds', title: 'First Two Thirds', icon: 'window-two-thirds', keywords: ['third', 'tile'], kind: frame({ kind: 'two-thirds', twoThirds: 'first' }) },
  { id: 'last-two-thirds', title: 'Last Two Thirds', icon: 'window-two-thirds', keywords: ['third', 'tile'], kind: frame({ kind: 'two-thirds', twoThirds: 'last' }) },
  { id: 'maximize', title: 'Maximize', icon: 'window-maximize', keywords: ['fill', 'full'], kind: frame({ kind: 'maximize' }) },
  { id: 'almost-maximize', title: 'Almost Maximize', icon: 'window-almost-maximize', keywords: ['fill'], kind: frame({ kind: 'almost-maximize' }) },
  { id: 'maximize-height', title: 'Maximize Height', icon: 'window-maximize-height', keywords: ['tall', 'vertical'], kind: frame({ kind: 'maximize-height' }) },
  { id: 'maximize-width', title: 'Maximize Width', icon: 'window-maximize-width', keywords: ['wide', 'horizontal'], kind: frame({ kind: 'maximize-width' }) },
  { id: 'reasonable-size', title: 'Reasonable Size', icon: 'window-reasonable-size', keywords: ['default'], kind: frame({ kind: 'reasonable-size' }) },
  { id: 'center', title: 'Center', icon: 'window-center', keywords: ['middle'], kind: frame({ kind: 'center' }) },
  { id: 'restore', title: 'Restore', icon: 'window-restore', keywords: ['undo', 'previous position'], kind: { type: 'restore' } },
  { id: 'make-larger', title: 'Make Larger', icon: 'window-larger', keywords: ['grow', 'resize', 'bigger'], kind: frame({ kind: 'make-larger' }) },
  { id: 'make-smaller', title: 'Make Smaller', icon: 'window-smaller', keywords: ['shrink', 'resize'], kind: frame({ kind: 'make-smaller' }) },
  { id: 'move-left', title: 'Move Left', icon: 'window-move', keywords: ['nudge'], kind: frame({ kind: 'move', direction: 'left' }) },
  { id: 'move-right', title: 'Move Right', icon: 'window-move', keywords: ['nudge'], kind: frame({ kind: 'move', direction: 'right' }) },
  { id: 'move-up', title: 'Move Up', icon: 'window-move', keywords: ['nudge'], kind: frame({ kind: 'move', direction: 'up' }) },
  { id: 'move-down', title: 'Move Down', icon: 'window-move', keywords: ['nudge'], kind: frame({ kind: 'move', direction: 'down' }) },
  { id: 'next-display', title: 'Next Display', icon: 'display-next', keywords: ['monitor', 'screen'], kind: { type: 'next-display' } },
  { id: 'previous-display', title: 'Previous Display', icon: 'display-previous', keywords: ['monitor', 'screen'], kind: { type: 'previous-display' } },
  { id: 'toggle-fullscreen', title: 'Toggle Fullscreen', icon: 'window-fullscreen', keywords: ['full screen'], kind: { type: 'toggle-fullscreen' } },
]
