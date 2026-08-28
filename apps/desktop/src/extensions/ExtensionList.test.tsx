import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { UiNode } from '@openray/protocol'

/**
 * `List.onSelectionChange` is how Raycast's master-detail extensions work:
 * the extension keeps the selected id in its own state and renders the
 * right-hand pane from it. The prop was declared by the shim but never
 * fired by the renderer, so such an extension stayed on whatever it
 * started with — `world-clock` asked its API for the time in an empty
 * timezone, got HTTP 400, and drew `NaN` where the clock face belonged.
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

function node(id: string, type: string, props: Record<string, unknown>, children: string[] = []): UiNode {
  return { id, type, props, children } as UiNode
}

function listSnapshot(withCallback: boolean) {
  return {
    rootId: 'root',
    nodes: {
      root: node('root', '__root', {}, ['list']),
      list: node(
        'list',
        'List',
        withCallback ? { onSelectionChange: { __callback: 'cb-select' } } : {},
        ['a', 'b'],
      ),
      a: node('a', 'List.Item', { id: 'Africa/Abidjan', title: 'Africa/Abidjan' }),
      b: node('b', 'List.Item', { id: 'Africa/Accra', title: 'Africa/Accra' }),
    },
  }
}

let container: HTMLDivElement
let root: Root

function render(snapshot: ReturnType<typeof listSnapshot>) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    extensionTreeStore.apply({ kind: 'snapshot', snapshot })
    root.render(<ExtensionView />)
  })
}

beforeEach(() => {
  invoked.length = 0
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  act(() => extensionTreeStore.reset())
})

function press(key: string) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
}

describe('List onSelectionChange', () => {
  it("reports the first row's own id on mount", () => {
    render(listSnapshot(true))

    expect(invoked).toEqual([{ id: 'cb-select', args: ['Africa/Abidjan'] }])
  })

  it('reports the new id when the selection moves', () => {
    render(listSnapshot(true))
    invoked.length = 0

    press('ArrowDown')

    expect(invoked.map((call) => call.args[0])).toEqual(['Africa/Accra'])
  })

  it('stays silent when the extension did not ask for selection changes', () => {
    render(listSnapshot(false))
    press('ArrowDown')

    expect(invoked).toHaveLength(0)
  })
})

describe('List filtering', () => {
  function withProps(props: Record<string, unknown>) {
    return {
      rootId: 'root',
      nodes: {
        root: node('root', '__root', {}, ['list']),
        list: node('list', 'List', props, ['a', 'b']),
        a: node('a', 'List.Item', { id: 'a', title: 'Alpha' }),
        b: node('b', 'List.Item', { id: 'b', title: 'Beta' }),
      },
    }
  }

  function type(text: string) {
    const input = container.querySelector('input')
    if (!input) throw new Error('no search input')
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, text)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  function titles() {
    return [...container.querySelectorAll('.openray-list-item-title')].map((n) => n.textContent)
  }

  it('filters by default when the extension does not handle search itself', () => {
    render(withProps({}))
    type('alp')

    expect(titles()).toEqual(['Alpha'])
  })

  it('leaves filtering to the extension when it wires onSearchTextChange', () => {
    // The extension re-renders its own rows in response, so filtering
    // locally as well would hide the ones it just chose to show.
    render(withProps({ onSearchTextChange: { __callback: 'cb-search' } }))
    type('zzz')

    expect(titles()).toEqual(['Alpha', 'Beta'])
  })

  it('filters anyway when the extension explicitly asks it to', () => {
    // `devdocs` renders `<List filtering={true} onSearchTextChange={…}>`,
    // using the text only to match an alias — typing matched nothing until
    // the prop was honoured.
    render(withProps({ filtering: true, onSearchTextChange: { __callback: 'cb-search' } }))
    type('bet')

    expect(titles()).toEqual(['Beta'])
  })

  it('matches an item by its keywords, which it never displays', () => {
    // `devdocs` tags each docset with its alias — `keywords={["java"]}` on
    // rows titled "OpenJDK" — so searching "java" found nothing while
    // "css", which is in its own title, worked.
    render({
      rootId: 'root',
      nodes: {
        root: node('root', '__root', {}, ['list']),
        list: node('list', 'List', {}, ['a', 'b']),
        a: node('a', 'List.Item', { id: 'a', title: 'OpenJDK', keywords: ['java'] }),
        b: node('b', 'List.Item', { id: 'b', title: 'Beta' }),
      },
    })
    type('java')

    expect(titles()).toEqual(['OpenJDK'])
  })

  it('honours filtering={false} even with no search callback', () => {
    render(withProps({ filtering: false }))
    type('zzz')

    expect(titles()).toEqual(['Alpha', 'Beta'])
  })
})
