import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { UiNode } from '@openray/protocol'

/**
 * `Action.SubmitForm` used to be handled by finding the *first* one in the
 * panel: a form offering several ("Create Extension", "Create and Open
 * Folder", …, which is what Raycast's own Create Extension does) could
 * only ever run that one. Picking any other from the ⌘K menu did nothing
 * at all, because the menu invokes `onAction` and a submit action carries
 * `onSubmit` — which also needs the collected form values passed to it.
 */

const invoked: { id: string; args: unknown[] }[] = []

vi.mock('../ipc/extensionHost', () => ({
  invokeExtensionCallback: (id: string, args: unknown[]) => {
    invoked.push({ id, args })
    return Promise.resolve()
  },
}))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: () => Promise.resolve({}),
  convertFileSrc: (path: string) => path,
}))
vi.mock('@tauri-apps/api/event', () => ({ listen: () => Promise.resolve(() => {}) }))

const { ExtensionView } = await import('./TreeRenderer')
const { extensionTreeStore } = await import('./registry')

/** A form with a text field and three submit actions, the middle two
 *  carrying their own shortcut — the Create Extension shape. */
function formSnapshot(): { rootId: string; nodes: Record<string, UiNode> } {
  const node = (id: string, type: string, props: Record<string, unknown>, children: string[] = []): UiNode =>
    ({ id, type, props, children }) as UiNode

  return {
    rootId: 'root',
    nodes: {
      root: node('root', '__root', {}, ['form']),
      form: node('form', 'Form', {}, ['field', 'empty', 'pick', 'slot']),
      field: node('field', 'Form.TextField', { id: 'name', title: 'Name', defaultValue: 'typed' }),
      empty: node('empty', 'Form.TextField', { id: 'untouched', title: 'Untouched' }),
      pick: node('pick', 'Form.Dropdown', { id: 'template', title: 'Template' }, ['pick-a', 'pick-b']),
      'pick-a': node('pick-a', 'Form.Dropdown.Item', { value: 'list', title: 'List' }),
      'pick-b': node('pick-b', 'Form.Dropdown.Item', { value: 'detail', title: 'Detail' }),
      slot: node('slot', '__actions', {}, ['panel']),
      panel: node('panel', 'ActionPanel', {}, ['primary', 'folder', 'copy']),
      primary: node('primary', 'Action', {
        title: 'Create Extension',
        __variant: 'submit-form',
        onSubmit: { __callback: 'cb-primary' },
      }),
      folder: node('folder', 'Action', {
        title: 'Create and Open Folder',
        __variant: 'submit-form',
        shortcut: { modifiers: ['cmd', 'ctrl'], key: 'enter' },
        onSubmit: { __callback: 'cb-folder' },
      }),
      copy: node('copy', 'Action', {
        title: 'Create and Copy Folder Path',
        __variant: 'submit-form',
        shortcut: { modifiers: ['cmd', 'opt'], key: 'enter' },
        onSubmit: { __callback: 'cb-copy' },
      }),
    },
  }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  invoked.length = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    extensionTreeStore.apply({ kind: 'snapshot', snapshot: formSnapshot() })
    root.render(<ExtensionView />)
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  act(() => extensionTreeStore.reset())
})

function press(key: string, modifiers: Partial<KeyboardEventInit> = {}) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...modifiers }))
  })
}

function clickAction(title: string) {
  const row = [...container.querySelectorAll('.openray-action-item')].find((element) =>
    element.textContent?.includes(title),
  )
  if (!row) throw new Error(`no action row titled ${title}`)
  act(() => {
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('ExtensionForm submit actions', () => {
  it('lists every submit action in the ⌘K menu', () => {
    press('k', { ctrlKey: true })

    const titles = [...container.querySelectorAll('.openray-action-item-title')].map((n) => n.textContent)
    expect(titles).toEqual(['Create Extension', 'Create and Open Folder', 'Create and Copy Folder Path'])
  })

  it('runs the action picked from the menu, not always the first', () => {
    press('k', { ctrlKey: true })
    clickAction('Create and Copy Folder Path')

    expect(invoked.map((call) => call.id)).toEqual(['cb-copy'])
  })

  it('passes the collected form values to the action it runs', () => {
    press('k', { ctrlKey: true })
    clickAction('Create and Open Folder')

    expect(invoked[0]?.args[0]).toMatchObject({ name: 'typed' })
  })

  it("submits a prefilled field's value even when it was never edited", () => {
    // `Create Extension` showed this: its Location field is prefilled, and
    // submitting straight away failed with "Enter an absolute folder path"
    // against a box that visibly held one.
    press('Enter', { ctrlKey: true })

    expect(invoked[0]?.args[0]).toMatchObject({ name: 'typed' })
  })

  it('submits a dropdown as the option it is showing', () => {
    press('Enter', { ctrlKey: true })

    expect(invoked[0]?.args[0]).toMatchObject({ template: 'list' })
  })

  it('submits an empty field as an empty string, not a missing key', () => {
    press('Enter', { ctrlKey: true })

    expect(invoked[0]?.args[0]).toMatchObject({ untouched: '' })
  })

  it('runs the primary action on plain ⌘↵', () => {
    press('Enter', { ctrlKey: true })

    expect(invoked.map((call) => call.id)).toEqual(['cb-primary'])
  })

  it('runs the action whose own shortcut was pressed', () => {
    press('Enter', { ctrlKey: true, altKey: true })

    expect(invoked.map((call) => call.id)).toEqual(['cb-copy'])
  })

  it('does not also run the primary action for a richer combination', () => {
    // The failure this guards: ⌘⌃↵ matching both "Create and Open Folder"
    // and the plain-⌘↵ fallback, creating the extension twice.
    press('Enter', { ctrlKey: true, shiftKey: false, altKey: false, metaKey: false })
    invoked.length = 0

    press('Enter', { ctrlKey: true, altKey: true })
    expect(invoked).toHaveLength(1)
  })
})

