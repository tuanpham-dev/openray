import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, type ComponentProps } from 'react'

/**
 * Uninstall and Remove sit inches from the Enable toggle on the same row and
 * neither has an undo — uninstalling drops the extension's files plus every
 * alias and hotkey bound to its commands. These cover the part that actually
 * protects someone: that declining the prompt performs no removal at all.
 *
 * The prompt is the app's own `ConfirmDialog`, never `window.confirm`: in the
 * WebKitGTK webview this ships in, `window.confirm` returns truthy without
 * drawing anything, so a guard written against it approves everything
 * silently. These assert the dialog is really in the tree and that the
 * removal only fires from its confirm button — which also catches a
 * regression back to an API that cannot work here.
 */

// `[]`, not `{}` — ExtensionPrefsForm stores whatever this resolves to as its
// definitions list and then iterates it. An object makes the render throw once
// the promise settles, which a synchronous test never reached.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: () => Promise.resolve([]),
  convertFileSrc: (path: string) => path,
}))
vi.mock('@tauri-apps/api/event', () => ({ listen: () => Promise.resolve(() => {}) }))

const { ExtensionSettingsView } = await import('./ExtensionSettingsView')

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

type Props = ComponentProps<typeof ExtensionSettingsView>

function baseProps(overrides: Partial<Props> = {}): Props {
  return {
    extension: {
      id: 'chrome-profile-launcher',
      title: 'Chrome Profile Launcher',
      source: 'installed',
      enabled: true,
      version: '1.0.0',
      sourceUrl: 'https://example.test/registry/',
      path: '/home/someone/ext',
    },
    commands: [],
    commandSettings: {},
    settings: {},
    onSettingsChange: () => {},
    onToggleExtension: () => {},
    onAlias: () => {},
    onHotkey: () => {},
    onEnabled: () => {},
    onUninstall: () => {},
    onStopDeveloping: () => {},
    onResumeDeveloping: () => {},
    onRemoveDev: () => {},
    ...overrides,
  } as Props
}

function render(props: Props) {
  act(() => root.render(<ExtensionSettingsView {...props} />))
}

function clickButton(label: string, root: ParentNode = container) {
  const button = [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)
  if (!button) throw new Error(`no "${label}" button rendered`)
  act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

function dialog(): HTMLElement | null {
  return container.querySelector('[role="alertdialog"]')
}

function dialogText(): string {
  return dialog()?.textContent ?? ''
}

describe('removing an extension asks first', () => {
  it('shows a dialog instead of removing anything on the first click', () => {
    const onUninstall = vi.fn()
    render(baseProps({ onUninstall }))

    expect(dialog()).toBeNull()
    clickButton('Uninstall')
    expect(dialog()).not.toBeNull()
    expect(onUninstall).not.toHaveBeenCalled()
  })

  it('does not uninstall when the dialog is cancelled', () => {
    const onUninstall = vi.fn()
    render(baseProps({ onUninstall }))

    clickButton('Uninstall')
    clickButton('Cancel', dialog() as ParentNode)
    expect(dialog()).toBeNull()
    expect(onUninstall).not.toHaveBeenCalled()
  })

  it('uninstalls only from the dialog’s own confirm button', () => {
    const onUninstall = vi.fn()
    render(baseProps({ onUninstall }))

    clickButton('Uninstall')
    clickButton('Uninstall', dialog() as ParentNode)
    expect(onUninstall).toHaveBeenCalledWith('chrome-profile-launcher')
    expect(dialog()).toBeNull()
  })

  it('says the data survives, so "uninstall" is not read as "erase"', () => {
    render(baseProps({}))

    clickButton('Uninstall')
    const text = dialogText()
    expect(text).toContain('Chrome Profile Launcher')
    expect(text).toContain('Data it has stored is kept')
    expect(text).toContain('https://example.test/registry/')
  })

  it('does not remove a dev extension when the dialog is cancelled', () => {
    const onRemoveDev = vi.fn()
    render(baseProps({ onRemoveDev, extension: { ...baseProps().extension, source: 'dev' } }))

    clickButton('Remove')
    expect(dialog()).not.toBeNull()
    clickButton('Cancel', dialog() as ParentNode)
    expect(onRemoveDev).not.toHaveBeenCalled()
  })

  it('promises a dev removal leaves the author’s folder alone', () => {
    const onRemoveDev = vi.fn()
    render(baseProps({ onRemoveDev, extension: { ...baseProps().extension, source: 'dev' } }))

    clickButton('Remove')
    // The distinction from Uninstall is the whole reason both exist.
    expect(dialogText()).toContain('/home/someone/ext')
    expect(dialogText()).toContain('left alone')
    clickButton('Remove', dialog() as ParentNode)
    expect(onRemoveDev).toHaveBeenCalledWith('chrome-profile-launcher')
  })
})
