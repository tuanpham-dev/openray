import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { ActionPanel } from './ActionPanel'
import type { PaletteAction } from '../state/actions'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: () => Promise.resolve({}),
  convertFileSrc: (path: string) => path,
}))
vi.mock('@tauri-apps/api/event', () => ({ listen: () => Promise.resolve(() => {}) }))

let container: HTMLDivElement | null = null
let root: Root | null = null

function render(actions: PaletteAction[], onClose = () => {}) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(<ActionPanel actions={actions} onClose={onClose} />)
  })
  return container
}

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
})

function titles(panel: HTMLElement): string[] {
  return Array.from(panel.querySelectorAll('.openray-action-item-title')).map((el) => el.textContent)
}

function type(input: HTMLInputElement, value: string) {
  // React listens for `input` events through its own tracker, which has
  // to see the value change *after* it last read it.
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('ActionPanel search', () => {
  const actions: PaletteAction[] = [
    { id: 'open', title: 'Open', onAction: () => {} },
    { id: 'copy-name', title: 'Copy Name', onAction: () => {} },
    { id: 'copy-path', title: 'Copy Path', onAction: () => {} },
  ]

  it('focuses its own search field so typing filters actions, not the list', () => {
    const panel = render(actions)
    const input = panel.querySelector<HTMLInputElement>('.openray-action-panel-search')!

    expect(document.activeElement).toBe(input)
  })

  it('narrows the rows to fuzzy matches of the query', () => {
    const panel = render(actions)
    const input = panel.querySelector<HTMLInputElement>('.openray-action-panel-search')!

    type(input, 'copy')

    expect(titles(panel)).toEqual(['Copy Name', 'Copy Path'])
  })

  it('runs the highlighted match on Enter, not the first action overall', () => {
    const ran: string[] = []
    const onClose = vi.fn()
    const panel = render(
      actions.map((action) => ({ ...action, onAction: () => void ran.push(action.id) })),
      onClose,
    )
    const input = panel.querySelector<HTMLInputElement>('.openray-action-panel-search')!

    type(input, 'path')
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    expect(ran).toEqual(['copy-path'])
    expect(onClose).toHaveBeenCalled()
  })

  it('clears a typed filter on the first Escape and closes on the second', () => {
    const onClose = vi.fn()
    const panel = render(actions, onClose)
    const input = panel.querySelector<HTMLInputElement>('.openray-action-panel-search')!
    const escape = () =>
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      })

    type(input, 'copy')
    escape()

    expect(input.value).toBe('')
    expect(titles(panel)).toEqual(['Open', 'Copy Name', 'Copy Path'])
    expect(onClose).not.toHaveBeenCalled()

    escape()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('says so when nothing matches', () => {
    const panel = render(actions)
    const input = panel.querySelector<HTMLInputElement>('.openray-action-panel-search')!

    type(input, 'zzz')

    expect(titles(panel)).toEqual([])
    expect(panel.querySelector('.openray-action-panel-empty')?.textContent).toBe('No matching actions')
  })
})
