import { createElement, useState } from 'react'
import { describe, expect, it, beforeEach } from 'vitest'
import type { UiTreeCommit } from '@openray/protocol'
import { _resetNodeIdsForTests, invokeCallback, mount } from '../src/reconciler'
import { getCommandContext, setCommandContext } from '../src/api/command-context'

function collect(): { commits: UiTreeCommit[]; onCommit: (c: UiTreeCommit) => void } {
  const commits: UiTreeCommit[] = []
  return { commits, onCommit: (c) => commits.push(c) }
}

/**
 * react-reconciler schedules commits through the `scheduler` package even
 * in legacy-root mode — nothing here is synchronous. One macrotask tick is
 * enough for it to drain in Node; the real sidecar just lets Node's event
 * loop do this naturally.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

beforeEach(() => {
  _resetNodeIdsForTests()
})

describe('reconciler mount', () => {
  it('emits a full snapshot on first mount', async () => {
    const { commits, onCommit } = collect()
    const tree = createElement(
      'List',
      { isLoading: false },
      createElement('List.Item', { key: 'a', title: 'Alpha' }),
      createElement('List.Item', { key: 'b', title: 'Beta' }),
    )

    mount(tree, onCommit)
    await flush()

    expect(commits).toHaveLength(1)
    const commit = commits[0]
    if (commit?.kind !== 'snapshot') throw new Error('expected a snapshot commit')
    const root = commit.snapshot.nodes[commit.snapshot.rootId]
    expect(root?.type).toBe('__root')
    const list = commit.snapshot.nodes[root!.children[0]!]
    expect(list?.type).toBe('List')
    expect(list?.children).toHaveLength(2)
    const item1 = commit.snapshot.nodes[list!.children[0]!]
    expect(item1?.type).toBe('List.Item')
    expect(item1?.props.title).toBe('Alpha')
  })

  it('emits only updateProps for a single item whose props changed', async () => {
    const { commits, onCommit } = collect()

    function Root({ titles }: { titles: string[] }) {
      return createElement(
        'List',
        {},
        ...titles.map((title, i) => createElement('List.Item', { key: String(i), title })),
      )
    }

    let rerender: ((titles: string[]) => void) | null = null
    function Wrapper() {
      const [titles, setTitles] = useState(['Alpha', 'Beta'])
      rerender = setTitles
      return createElement(Root, { titles })
    }

    mount(createElement(Wrapper), onCommit)
    await flush()
    expect(commits).toHaveLength(1)

    rerender!(['Alpha Updated', 'Beta'])
    await flush()

    expect(commits).toHaveLength(2)
    const diff = commits[1]
    if (diff?.kind !== 'diff') throw new Error('expected a diff commit')
    expect(diff.ops).toHaveLength(1)
    expect(diff.ops[0]).toMatchObject({ op: 'updateProps', props: { title: 'Alpha Updated' } })
  })

  it('emits insert/remove ops for added and removed items', async () => {
    const { commits, onCommit } = collect()

    let rerender: ((titles: string[]) => void) | null = null
    function Wrapper() {
      const [titles, setTitles] = useState(['Alpha', 'Beta'])
      rerender = setTitles
      return createElement(
        'List',
        {},
        ...titles.map((title) => createElement('List.Item', { key: title, title })),
      )
    }

    mount(createElement(Wrapper), onCommit)
    await flush()
    rerender!(['Beta', 'Gamma'])
    await flush()

    const diff = commits[1]
    if (diff?.kind !== 'diff') throw new Error('expected a diff commit')
    const opKinds = diff.ops.map((o) => o.op)
    expect(opKinds).toContain('remove')
    expect(opKinds).toContain('insert')
  })

  it('emits a reorder op when child order changes without prop changes', async () => {
    const { commits, onCommit } = collect()

    let rerender: ((titles: string[]) => void) | null = null
    function Wrapper() {
      const [titles, setTitles] = useState(['Alpha', 'Beta'])
      rerender = setTitles
      return createElement(
        'List',
        {},
        ...titles.map((title) => createElement('List.Item', { key: title, title })),
      )
    }

    mount(createElement(Wrapper), onCommit)
    await flush()
    rerender!(['Beta', 'Alpha'])
    await flush()

    const diff = commits[1]
    if (diff?.kind !== 'diff') throw new Error('expected a diff commit')
    const reorder = diff.ops.find((o) => o.op === 'reorder')
    expect(reorder).toBeDefined()
  })

  it('routes an onAction callback prop through invokeCallback', async () => {
    const { onCommit } = collect()
    let called = false
    const tree = createElement(
      'List',
      {},
      createElement('List.Item', {
        key: 'a',
        title: 'Alpha',
        onAction: () => {
          called = true
        },
      }),
    )

    const handle = mount(tree, onCommit)
    await flush()
    const snapshot = handle.resync()
    if (snapshot.kind !== 'snapshot') throw new Error('expected snapshot')
    const item = Object.values(snapshot.snapshot.nodes).find((n) => n.type === 'List.Item')
    const callbackMarker = item?.props.onAction as { __callback: string }
    expect(callbackMarker.__callback).toBeTruthy()

    invokeCallback(callbackMarker.__callback, [])
    expect(called).toBe(true)
  })
})

describe('extension asset paths', () => {
  it('resolves a relative icon path against the extension assets directory', async () => {
    // Extensions reference their own files the way Raycast documents it:
    // `icon={{ source: "../assets/wikipedia.png" }}`, relative to the
    // compiled command. Sent as-is it matches neither an absolute path nor
    // a built-in icon name, and the renderer drew it as literal text —
    // rows showed "../a" where the thumbnail belonged.
    setCommandContext({ ...getCommandContext(), assetsPath: '/ext/wikipedia/assets' })
    const { commits, onCommit } = collect()
    mount(createElement('list' as never, { icon: { source: '../assets/wikipedia.png' } }), onCommit)
    await flush()

    const snapshot = commits.find((c) => c.kind === 'snapshot')
    const node = Object.values(snapshot?.snapshot.nodes ?? {}).find((n) => n.props?.icon)
    expect((node?.props.icon as { source: string }).source).toBe('/ext/wikipedia/assets/wikipedia.png')
  })

  it('resolves a bare asset name, which is how extensions usually write it', async () => {
    // `Image.Asset` is documented as "a string denoting an asset from the
    // `assets/` folder", with no prefix — `pokedex` writes
    // `icon={{ source: "body-style/8.png" }}`, and its Shape row rendered
    // that string as literal text.
    setCommandContext({ ...getCommandContext(), assetsPath: '/ext/pokedex/assets' })
    const { commits, onCommit } = collect()
    mount(createElement('list' as never, { icon: { source: 'body-style/8.png' } }), onCommit)
    await flush()

    const snapshot = commits.find((c) => c.kind === 'snapshot')
    const node = Object.values(snapshot?.snapshot.nodes ?? {}).find((n) => n.props?.icon)
    expect((node?.props.icon as { source: string }).source).toBe('/ext/pokedex/assets/body-style/8.png')
  })

  it('does not mistake a built-in icon name for a file', async () => {
    // The names are the risk of accepting bare paths: `arrow-up-circle`
    // must stay a name, and only something carrying a file extension is
    // treated as an asset.
    setCommandContext({ ...getCommandContext(), assetsPath: '/ext/pokedex/assets' })
    const { commits, onCommit } = collect()
    mount(createElement('list' as never, { icon: 'arrow-up-circle', source: 'trash' }), onCommit)
    await flush()

    const snapshot = commits.find((c) => c.kind === 'snapshot')
    const node = Object.values(snapshot?.snapshot.nodes ?? {}).find((n) => n.props?.icon)
    expect(node?.props.icon).toBe('arrow-up-circle')
    expect(node?.props.source).toBe('trash')
  })

  it('leaves absolute paths, URLs and icon names alone', async () => {
    setCommandContext({ ...getCommandContext(), assetsPath: '/ext/wikipedia/assets' })
    const { commits, onCommit } = collect()
    mount(
      createElement('list' as never, { icon: 'trash', source: 'https://example.test/a.png', image: '/already/absolute.png' }),
      onCommit,
    )
    await flush()

    const snapshot = commits.find((c) => c.kind === 'snapshot')
    const node = Object.values(snapshot?.snapshot.nodes ?? {}).find((n) => n.props?.icon)
    expect(node?.props.icon).toBe('trash')
    expect(node?.props.source).toBe('https://example.test/a.png')
    expect(node?.props.image).toBe('/already/absolute.png')
  })
})
