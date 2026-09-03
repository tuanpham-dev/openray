import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { Footer } from './Footer'

const invoke = vi.fn((..._args: unknown[]) => Promise.resolve())
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  convertFileSrc: (path: string) => path,
}))
vi.mock('@tauri-apps/api/event', () => ({ listen: () => Promise.resolve(() => {}) }))

let container: HTMLDivElement | null = null
let root: Root | null = null

function render(element: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(element)
  })
  return container
}

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
  invoke.mockClear()
})

function openMenu(footer: HTMLElement) {
  act(() => {
    footer.querySelector<HTMLButtonElement>('.openray-footer-brand')!.click()
  })
  return Array.from(footer.querySelectorAll<HTMLElement>('[role="menuitem"]'))
}

describe('Footer brand menu', () => {
  it('offers Settings at the root palette', () => {
    const footer = render(<Footer />)

    const items = openMenu(footer)

    expect(items.map((item) => item.textContent)).toEqual(['Open Settings⌘,'])
    act(() => items[0]!.click())
    expect(invoke.mock.calls.map((call) => call[0])).toEqual(['open_settings', 'hide_palette'])
    expect(footer.querySelector('[role="menu"]')).toBeNull()
  })

  it("offers the running extension's own settings page inside a command", () => {
    const footer = render(<Footer context="Clipboard History" extensionId="clipboard-history" />)

    const items = openMenu(footer)

    expect(items.map((item) => item.textContent)).toEqual(['Open Extension Settings'])
    act(() => items[0]!.click())
    expect(invoke.mock.calls[0]).toEqual(['open_extension_settings', { extensionId: 'clipboard-history' }])
  })

  it('closes on Escape without navigating the view underneath', () => {
    const footer = render(<Footer />)
    openMenu(footer)
    const underneath = vi.fn()
    window.addEventListener('keydown', underneath)

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })

    window.removeEventListener('keydown', underneath)
    expect(footer.querySelector('[role="menu"]')).toBeNull()
    expect(underneath).not.toHaveBeenCalled()
  })
})
