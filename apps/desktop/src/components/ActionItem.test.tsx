import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { ActionPanel } from './ActionPanel'
import type { PaletteAction } from '../state/actions'

// The panel reaches the settings store (hover-selection) and the asset
// protocol (file-path icons) on mount; neither exists outside the app.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: () => Promise.resolve({}),
  convertFileSrc: (path: string) => path,
}))
vi.mock('@tauri-apps/api/event', () => ({ listen: () => Promise.resolve(() => {}) }))

/**
 * The bug these cover: an extension's action carries its icon as a *name*
 * (`Icon.Trash` is the string `"trash"`), and the panel rendered that
 * string straight into the row — "trashDelete Recent Article", the word
 * printed over its own title.
 */

let container: HTMLDivElement | null = null
let root: Root | null = null

function render(actions: PaletteAction[]) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(<ActionPanel actions={actions} onClose={() => {}} />)
  })
  return container
}

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
})

function action(overrides: Partial<PaletteAction>): PaletteAction {
  return { id: 'a', title: 'Delete', onAction: () => {}, ...overrides }
}

describe('ActionItem icons', () => {
  it('resolves a Raycast icon name to a glyph instead of printing it', () => {
    const panel = render([action({ icon: 'trash' })])

    expect(panel.textContent).not.toContain('trash')
    expect(panel.querySelector('.openray-action-item-icon svg')).not.toBeNull()
  })

  it('drops an icon name it has no glyph for rather than printing it', () => {
    // `looksLikeIconName` territory: better a blank slot than a row
    // labelled "app-window-sidebar-right".
    const panel = render([action({ icon: 'no-such-icon-name' })])

    expect(panel.textContent).toBe('ActionsDelete')
  })

  it('still renders an emoji, which is content rather than a name', () => {
    const panel = render([action({ icon: '🌐' })])

    expect(panel.textContent).toContain('🌐')
  })

  it('reserves the icon slot on every row once any row has one', () => {
    // A mixed panel that indented only the rows with an icon left the
    // titles in a ragged column.
    const panel = render([
      action({ id: 'a', title: 'Delete', icon: 'trash' }),
      action({ id: 'b', title: 'Rename' }),
    ])

    expect(panel.querySelectorAll('.openray-action-item-icon')).toHaveLength(2)
  })

  it('reserves nothing when no action has an icon', () => {
    const panel = render([action({ id: 'a', title: 'Delete' }), action({ id: 'b', title: 'Rename' })])

    expect(panel.querySelectorAll('.openray-action-item-icon')).toHaveLength(0)
  })
})
