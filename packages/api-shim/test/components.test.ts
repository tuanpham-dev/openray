import { createElement } from 'react'
import { describe, expect, it, beforeEach } from 'vitest'
import type { UiTreeCommit, UiNode } from '@openray/protocol'
import { _resetNodeIdsForTests, invokeCallback, mount } from '../src/reconciler'
import { List } from '../src/components/List'
import { Grid } from '../src/components/Grid'
import { Detail } from '../src/components/Detail'
import { ActionPanel, Action } from '../src/components/ActionPanel'
import { Form } from '../src/components/Form'
import { MenuBarExtra } from '../src/components/MenuBarExtra'
import { useNavigation } from '../src/hooks'
import { flush } from './flush'

function collect(): { commits: UiTreeCommit[]; onCommit: (c: UiTreeCommit) => void } {
  const commits: UiTreeCommit[] = []
  return { commits, onCommit: (c) => commits.push(c) }
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

describe('built-in action icons', () => {
  /**
   * Raycast's built-in actions each ship with their own icon. Ours carried
   * none, so a panel mixing them with actions that named an icon showed
   * blank rows next to filled ones — visible in `wikipedia`, where only
   * the two `Icon.Trash` entries had anything at all.
   */
  it('gives Action.OpenInBrowser and Action.CopyToClipboard a default icon', async () => {
    const { commits, onCommit } = collect()
    mount(
      createElement(
        List,
        null,
        createElement(List.Item, {
          title: 'Row',
          actions: createElement(
            ActionPanel,
            null,
            createElement(Action.OpenInBrowser, { url: 'https://example.com' }),
            createElement(Action.CopyToClipboard, { content: 'text' }),
          ),
        }),
      ),
      onCommit,
    )
    await flush()

    const icons = nodesByType(commits.at(-1)!, 'Action').map((node) => node.props.icon)
    expect(icons).toEqual(['globe', 'clipboard'])
  })

  it('lets an extension override the default', async () => {
    const { commits, onCommit } = collect()
    mount(
      createElement(
        List,
        null,
        createElement(List.Item, {
          title: 'Row',
          actions: createElement(ActionPanel, null, createElement(Action.OpenInBrowser, { url: 'https://example.com', icon: 'star' })),
        }),
      ),
      onCommit,
    )
    await flush()

    expect(nodesByType(commits.at(-1)!, 'Action')[0]?.props.icon).toBe('star')
  })
})

describe('unimplemented Action variants', () => {
  /**
   * The failure this prevents: `Action.CreateSnippet` was `undefined`, so
   * React threw "Element type is invalid" during render and
   * `unicode-symbols` mounted nothing at all — a whole extension lost to
   * one action in a menu the user might never open.
   */
  it('renders an unknown Action.* as a row instead of undefined', async () => {
    const { commits, onCommit } = collect()
    mount(
      createElement(
        List,
        null,
        createElement(List.Item, {
          title: 'Row',
          actions: createElement(
            ActionPanel,
            null,
            // @ts-expect-error deliberately an action this shim doesn't implement
            createElement(Action.ToggleQuickLook, {}),
          ),
        }),
      ),
      onCommit,
    )
    await flush()

    const actions = nodesByType(commits.at(-1)!, 'Action')
    expect(actions).toHaveLength(1)
    expect(actions[0]?.props.title).toBe('ToggleQuickLook')
  })

  it('keeps one component identity per variant, so rows do not remount', () => {
    // @ts-expect-error same deliberately-missing variant
    expect(Action.ToggleQuickLook).toBe(Action.ToggleQuickLook)
  })

  it('leaves real members and non-component properties alone', () => {
    expect(Action.Style.Destructive).toBe('destructive')
    expect(Action.CopyToClipboard).toBeTypeOf('function')
    // Lower-cased and symbol lookups must not become components.
    expect((Action as unknown as Record<string, unknown>).nope).toBeUndefined()
  })

  it('renders Action.CreateSnippet, which has no store to write to', async () => {
    const { commits, onCommit } = collect()
    mount(
      createElement(
        List,
        null,
        createElement(List.Item, {
          title: 'Row',
          actions: createElement(ActionPanel, null, createElement(Action.CreateSnippet, { snippet: { text: 'x' } })),
        }),
      ),
      onCommit,
    )
    await flush()

    expect(nodesByType(commits.at(-1)!, 'Action')[0]?.props.title).toBe('Create Snippet')
  })
})

describe('unimplemented namespace members', () => {
  /**
   * The failure these prevent: a missing member is `undefined`, React
   * throws "Element type is invalid", and the whole command fails to
   * mount. 49 of 180 sampled extensions used at least one such member.
   */
  it('renders an unknown Form.* as an inert note instead of crashing', async () => {
    const { commits, onCommit } = collect()
    // @ts-expect-error deliberately a Form member this shim doesn't implement
    mount(createElement(Form, null, createElement(Form.LinkAccessory, { id: 'link', title: 'Link' })), onCommit)
    await flush()

    const nodes = nodesByType(commits.at(-1)!, 'Form.Unsupported')
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.props.name).toBe('LinkAccessory')
  })

  it('renders an unknown List.* as nothing, without disturbing its siblings', async () => {
    const { commits, onCommit } = collect()
    mount(
      createElement(
        List,
        null,
        // @ts-expect-error deliberately a List member this shim doesn't implement
        createElement(List.SomethingNew, {}),
        createElement(List.Item, { title: 'Real row' }),
      ),
      onCommit,
    )
    await flush()

    expect(nodesByType(commits.at(-1)!, 'List.Item')).toHaveLength(1)
  })

  it('mounts a MenuBarExtra tree', async () => {
    const { commits, onCommit } = collect()
    mount(
      createElement(
        MenuBarExtra,
        { title: 'Status' },
        createElement(MenuBarExtra.Section, { title: 'Recent' }, createElement(MenuBarExtra.Item, { title: 'Open' })),
      ),
      onCommit,
    )
    await flush()

    expect(nodesByType(commits.at(-1)!, 'MenuBarExtra')).toHaveLength(1)
    expect(nodesByType(commits.at(-1)!, 'MenuBarExtra.Item')[0]?.props.title).toBe('Open')
  })
})

describe('Form.DatePicker value type', () => {
  /**
   * The bug this prevents: `Form.DatePicker`'s value is a `Date` on the
   * extension's side, but props cross to the renderer as JSON. Sending a
   * bare ISO string meant `onSubmit` handed the extension a *string*, and
   * the very first thing an extension does is `values.when.getTime()`.
   */
  it('hands onSubmit a real Date, not the string it crossed as', async () => {
    let received: Record<string, unknown> | undefined
    const { commits, onCommit } = collect()
    mount(
      createElement(
        Form,
        {
          actions: createElement(
            ActionPanel,
            null,
            createElement(Action.SubmitForm, {
              title: 'Go',
              onSubmit: (values: Record<string, unknown>) => {
                received = values
              },
            }),
          ),
        },
        createElement(Form.DatePicker, { id: 'when', title: 'When' }),
      ),
      onCommit,
    )
    await flush()

    const submit = nodesByType(commits.at(-1)!, 'Action').find((n) => n.props.__variant === 'submit-form')
    const callbackId = (submit?.props.onSubmit as { __callback: string }).__callback
    invokeCallback(callbackId, [{ when: { __date: '2026-08-28T00:00:00.000Z' }, note: 'plain' }])

    expect(received?.when).toBeInstanceOf(Date)
    expect((received?.when as Date).toISOString()).toBe('2026-08-28T00:00:00.000Z')
    // Everything else passes through untouched.
    expect(received?.note).toBe('plain')
  })

  it('hands over null for a date that was never picked', async () => {
    let received: Record<string, unknown> | undefined
    const { commits, onCommit } = collect()
    mount(
      createElement(Form, {
        actions: createElement(
          ActionPanel,
          null,
          createElement(Action.SubmitForm, {
            title: 'Go',
            onSubmit: (values: Record<string, unknown>) => {
              received = values
            },
          }),
        ),
      }),
      onCommit,
    )
    await flush()

    const submit = nodesByType(commits.at(-1)!, 'Action').find((n) => n.props.__variant === 'submit-form')
    invokeCallback((submit?.props.onSubmit as { __callback: string }).__callback, [{ when: { __date: null } }])

    expect(received?.when).toBeNull()
  })
})
