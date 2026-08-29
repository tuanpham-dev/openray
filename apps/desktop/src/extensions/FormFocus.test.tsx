import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { UiNode } from '@openray/protocol'

/**
 * `useForm().focus(id)` — and its focus-the-first-invalid-field on a failed
 * submit — reach the renderer as a bumped nonce on the field itself, not as
 * a new protocol message. React's own `autoFocus` can't serve: it applies
 * only at mount, so a second request for an already-mounted field would do
 * nothing at all.
 */

vi.mock('../ipc/extensionHost', () => ({ invokeExtensionCallback: () => Promise.resolve() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: () => Promise.resolve({}), convertFileSrc: (p: string) => p }))
vi.mock('@tauri-apps/api/event', () => ({ listen: () => Promise.resolve(() => {}) }))

const { ExtensionView } = await import('./TreeRenderer')
const { extensionTreeStore } = await import('./registry')

function node(id: string, type: string, props: Record<string, unknown>, children: string[] = []): UiNode {
  return { id, type, props, children } as UiNode
}

let container: HTMLDivElement
let root: Root

function render(focusRequest: number | undefined) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    extensionTreeStore.apply({
      kind: 'snapshot',
      snapshot: {
        rootId: 'root',
        nodes: {
          root: node('root', '__root', {}, ['form']),
          form: node('form', 'Form', {}, ['a', 'b']),
          a: node('a', 'Form.TextField', {
            id: 'first',
            title: 'First',
            ...(focusRequest === undefined ? {} : { focusRequest }),
          }),
          b: node('b', 'Form.TextField', { id: 'second', title: 'Second' }),
        },
      },
    })
    root.render(<ExtensionView />)
  })
}

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  act(() => extensionTreeStore.reset())
})

describe('form field focus requests', () => {
  it('focuses the field carrying a request', () => {
    render(1)

    expect(document.activeElement).toBe(container.querySelectorAll('input')[0])
  })

  it('leaves focus alone when no field asks for it', () => {
    render(undefined)

    expect(document.activeElement).not.toBe(container.querySelectorAll('input')[0])
  })
})
