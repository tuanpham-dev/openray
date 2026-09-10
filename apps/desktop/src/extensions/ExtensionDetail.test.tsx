import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { UiNode } from '@openray/protocol'

/**
 * A `Detail` has no rows to move between, so the arrow keys did nothing at
 * all and long content could only be read with the mouse — the shell
 * extension's command output being the case that prompted this.
 */

let altJkNavigation = true

vi.mock('../ipc/extensionHost', () => ({
  invokeExtensionCallback: () => Promise.resolve(),
}))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: () => Promise.resolve({}),
  convertFileSrc: (path: string) => path,
}))
vi.mock('@tauri-apps/api/event', () => ({ listen: () => Promise.resolve(() => {}) }))
vi.mock('../state/appSettings', () => ({
  useAppSettings: () => ({ altJkNavigation }),
}))

const { ExtensionView } = await import('./TreeRenderer')
const { extensionTreeStore } = await import('./registry')

function node(id: string, type: string, props: Record<string, unknown>, children: string[] = []): UiNode {
  return { id, type, props, children } as UiNode
}

/** What the shell extension renders: markdown, and nothing else. */
function detailSnapshot(withMetadata = false) {
  const nodes: Record<string, UiNode> = {
    root: node('root', '__root', {}, ['detail']),
    detail: node('detail', 'Detail', { markdown: '```\n$ ls -la\ntotal 16\n```' }, withMetadata ? ['meta'] : []),
  }
  if (withMetadata) {
    nodes.meta = node('meta', 'Detail.Metadata', {}, ['label'])
    nodes.label = node('label', 'Detail.Metadata.Label', { title: 'Author', text: 'someone' })
  }
  return { rootId: 'root', nodes }
}

let container: HTMLDivElement
let root: Root

function render(snapshot: ReturnType<typeof detailSnapshot>) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    extensionTreeStore.apply({ kind: 'snapshot', snapshot })
    root.render(<ExtensionView />)
  })
}

/** The element the view scrolls. jsdom lays nothing out, so it reports no
 *  height and would refuse to scroll — the scrollable range is faked here so
 *  the assertions are about the key handling, which is what this covers. */
function scroller(): HTMLElement {
  const element = container.querySelector('.openray-detail-page') as HTMLElement
  let scrollTop = 0
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = Math.max(0, value)
    },
  })
  return element
}

function press(key: string, init: KeyboardEventInit = {}) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }))
  })
}

beforeEach(() => {
  altJkNavigation = true
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  act(() => extensionTreeStore.reset())
})

describe('Detail keyboard scrolling', () => {
  it('scrolls down on ArrowDown and back up on ArrowUp', () => {
    render(detailSnapshot())
    const element = scroller()

    press('ArrowDown')
    const afterDown = element.scrollTop
    expect(afterDown).toBeGreaterThan(0)

    press('ArrowUp')
    expect(element.scrollTop).toBeLessThan(afterDown)
  })

  it('never scrolls above the top', () => {
    render(detailSnapshot())
    const element = scroller()

    press('ArrowUp')

    expect(element.scrollTop).toBe(0)
  })

  it('treats Alt+J/K as the arrow keys when that setting is on', () => {
    render(detailSnapshot())
    const element = scroller()

    // `code`, not `key`: with Alt held the letter is layout-dependent, which
    // is why `altNavigationDirection` matches the physical key.
    press('j', { altKey: true, code: 'KeyJ' })
    const afterDown = element.scrollTop
    expect(afterDown).toBeGreaterThan(0)

    press('k', { altKey: true, code: 'KeyK' })
    expect(element.scrollTop).toBeLessThan(afterDown)
  })

  it('leaves Alt+J alone when the setting is off, and still scrolls with the arrows', () => {
    altJkNavigation = false
    render(detailSnapshot())
    const element = scroller()

    press('j', { altKey: true, code: 'KeyJ' })
    expect(element.scrollTop).toBe(0)

    press('ArrowDown')
    expect(element.scrollTop).toBeGreaterThan(0)
  })

  it('scrolls a Detail that has metadata too', () => {
    render(detailSnapshot(true))
    const element = scroller()

    press('ArrowDown')

    expect(element.scrollTop).toBeGreaterThan(0)
  })
})
