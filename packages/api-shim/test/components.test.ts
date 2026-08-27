import { createElement } from 'react'
import { describe, expect, it, beforeEach } from 'vitest'
import type { UiTreeCommit, UiNode } from '@openray/protocol'
import { _resetNodeIdsForTests, invokeCallback, mount } from '../src/reconciler'
import { List } from '../src/components/List'
import { Grid } from '../src/components/Grid'
import { Detail } from '../src/components/Detail'
import { ActionPanel, Action } from '../src/components/ActionPanel'
import { useNavigation } from '../src/hooks'

function collect(): { commits: UiTreeCommit[]; onCommit: (c: UiTreeCommit) => void } {
  const commits: UiTreeCommit[] = []
  return { commits, onCommit: (c) => commits.push(c) }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function nodesByType(commit: UiTreeCommit, type: string): UiNode[] {
  if (commit.kind !== 'snapshot') throw new Error('expected a snapshot')
  return Object.values(commit.snapshot.nodes).filter((n) => n.type === type)
}

beforeEach(() => {
  _resetNodeIdsForTests()
})

describe('List component', () => {
  it('renders sections and items with an actions slot wired through invokeCallback', async () => {
    const { commits, onCommit } = collect()

    const tree = createElement(
      List,
      { isLoading: false },
      createElement(
        List.Section,
        { title: 'Results', key: 'sec' },
        createElement(List.Item, {
          key: 'a',
          title: 'Alpha',
          actions: createElement(
            ActionPanel,
            null,
            createElement(Action, { title: 'Open', onAction: () => called.push('open') }),
          ),
        }),
      ),
    )
    const called: string[] = []

    mount(tree, onCommit)
    await flush()

    const commit = commits[0]!
    expect(nodesByType(commit, 'List')).toHaveLength(1)
    expect(nodesByType(commit, 'List.Section')).toHaveLength(1)
    expect(nodesByType(commit, 'List.Item')).toHaveLength(1)
    expect(nodesByType(commit, '__actions')).toHaveLength(1)
    const action = nodesByType(commit, 'Action')[0]!
    const marker = action.props.onAction as { __callback: string }
    invokeCallback(marker.__callback, [])
    expect(called).toEqual(['open'])
  })
})

describe('Detail component', () => {
  it('renders markdown content as a prop, not a text child', async () => {
    const { commits, onCommit } = collect()
    mount(createElement(Detail, { markdown: '# Hello' }), onCommit)
    await flush()

    const detail = nodesByType(commits[0]!, 'Detail')[0]!
    expect(detail.props.markdown).toBe('# Hello')
  })

  it('renders Metadata.TagList.Item nested under TagList with an actionable onAction', async () => {
    const { commits, onCommit } = collect()
    const called: string[] = []

    mount(
      createElement(
        Detail,
        {
          markdown: 'body',
          metadata: createElement(
            Detail.Metadata,
            null,
            createElement(
              Detail.Metadata.TagList,
              { title: 'Status', key: 'tags' },
              createElement(Detail.Metadata.TagList.Item, { text: 'Open', color: '#00ff00', onAction: () => called.push('tag') }),
            ),
          ),
        },
      ),
      onCommit,
    )
    await flush()

    const commit = commits[0]!
    const tagListItem = nodesByType(commit, 'Detail.Metadata.TagList.Item')[0]!
    expect(tagListItem.props.text).toBe('Open')
    expect(tagListItem.props.color).toBe('#00ff00')
    const marker = tagListItem.props.onAction as { __callback: string }
    invokeCallback(marker.__callback, [])
    expect(called).toEqual(['tag'])
  })
})

describe('Grid component', () => {
  it('renders Grid.EmptyView with an actions slot wired through invokeCallback', async () => {
    const { commits, onCommit } = collect()
    const called: string[] = []

    mount(
      createElement(
        Grid,
        {},
        createElement(Grid.EmptyView, {
          title: 'No results',
          actions: createElement(ActionPanel, null, createElement(Action, { title: 'Retry', onAction: () => called.push('retry') })),
        }),
      ),
      onCommit,
    )
    await flush()

    const commit = commits[0]!
    expect(nodesByType(commit, 'Grid.EmptyView')).toHaveLength(1)
    const emptyView = nodesByType(commit, 'Grid.EmptyView')[0]!
    expect(emptyView.props.title).toBe('No results')
    const action = nodesByType(commit, 'Action')[0]!
    const marker = action.props.onAction as { __callback: string }
    invokeCallback(marker.__callback, [])
    expect(called).toEqual(['retry'])
  })
})

describe('useNavigation', () => {
  it('push replaces the rendered top-level view, pop restores it', async () => {
    const { commits, onCommit } = collect()

    function Detail2() {
      const { pop } = useNavigation()
      return createElement(Detail, { markdown: 'pushed', actions: createElement(Action, { title: 'Back', onAction: pop }) })
    }

    function Root() {
      const { push } = useNavigation()
      return createElement(
        List,
        {},
        createElement(List.Item, {
          key: 'a',
          title: 'Alpha',
          actions: createElement(ActionPanel, null, createElement(Action, { title: 'Open', onAction: () => push(createElement(Detail2)) })),
        }),
      )
    }

    mount(createElement(Root), onCommit)
    await flush()
    expect(nodesByType(commits[0]!, 'List')).toHaveLength(1)

    const action = nodesByType(commits[0]!, 'Action')[0]!
    const openMarker = action.props.onAction as { __callback: string }
    invokeCallback(openMarker.__callback, [])
    await flush()

    const afterPush = commits[commits.length - 1]!
    if (afterPush.kind !== 'diff') throw new Error('expected a diff after push')
    const insertedDetail = afterPush.ops.find((op) => op.op === 'insert' && op.node.type === 'Detail')
    expect(insertedDetail).toBeDefined()
    const removedList = afterPush.ops.some((op) => op.op === 'remove')
    expect(removedList).toBe(true)

    // Regression: react-reconciler builds a brand-new subtree off-screen
    // via appendInitialChild (not appendChild/insertBefore), and only the
    // subtree's root gets attached to the live tree with one host-config
    // call. Insert-detection that only reacted to attach/attachBefore
    // calls emitted an `insert` for the pushed Detail node itself but
    // silently dropped its descendants (__actions, Action) — present in
    // the node's `children` array but never sent as their own nodes.
    const insertedTypes = afterPush.ops.filter((op) => op.op === 'insert').map((op) => (op.op === 'insert' ? op.node.type : ''))
    expect(insertedTypes).toEqual(expect.arrayContaining(['Detail', '__actions', 'Action']))
    expect(insertedTypes).toHaveLength(3)
  })
})
