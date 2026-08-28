import { describe, expect, it } from 'vitest'
import type { UiNode } from '@openray/protocol'
import { actionsFromSlot, findActionsSlot, matchesShortcut, parseShortcut } from './actions'

function keydown(key: string, modifiers: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { key, ...modifiers })
}

describe('parseShortcut', () => {
  it('lower-cases the key so it can be compared to a real event', () => {
    expect(parseShortcut({ modifiers: ['cmd'], key: 'Enter' })).toEqual({ modifiers: ['cmd'], key: 'enter' })
  })

  it('rejects a shortcut with no key', () => {
    expect(parseShortcut({ modifiers: ['cmd'] })).toBeNull()
    expect(parseShortcut(undefined)).toBeNull()
  })
})

describe('matchesShortcut', () => {
  const cmdEnter = parseShortcut({ modifiers: ['cmd'], key: 'enter' })!
  const cmdShiftEnter = parseShortcut({ modifiers: ['cmd', 'shift'], key: 'enter' })!
  const cmdOptEnter = parseShortcut({ modifiers: ['cmd', 'opt'], key: 'enter' })!

  it('accepts Ctrl for an extension’s cmd', () => {
    // Extensions are written on macOS, where every shortcut is ⌘, and
    // there is no second modifier on Linux they could have meant instead.
    expect(matchesShortcut(keydown('Enter', { ctrlKey: true }), cmdEnter)).toBe(true)
    expect(matchesShortcut(keydown('Enter', { metaKey: true }), cmdEnter)).toBe(true)
  })

  it('does not let a plainer combination match a richer shortcut', () => {
    // The bug this prevents: ⌘↵ firing "Create and Open Folder" because
    // its extra modifier was never checked.
    expect(matchesShortcut(keydown('Enter', { ctrlKey: true }), cmdShiftEnter)).toBe(false)
    expect(matchesShortcut(keydown('Enter', { ctrlKey: true }), cmdOptEnter)).toBe(false)
  })

  it('does not let a richer combination match a plainer shortcut', () => {
    expect(matchesShortcut(keydown('Enter', { ctrlKey: true, shiftKey: true }), cmdEnter)).toBe(false)
    expect(matchesShortcut(keydown('Enter', { ctrlKey: true, altKey: true }), cmdEnter)).toBe(false)
  })

  it('distinguishes the four Create Extension shortcuts from each other', () => {
    expect(matchesShortcut(keydown('Enter', { ctrlKey: true, shiftKey: true }), cmdShiftEnter)).toBe(true)
    expect(matchesShortcut(keydown('Enter', { ctrlKey: true, altKey: true }), cmdOptEnter)).toBe(true)
    expect(matchesShortcut(keydown('Enter', { ctrlKey: true, altKey: true }), cmdShiftEnter)).toBe(false)
  })

  it('keeps cmd+ctrl distinct from cmd alone', () => {
    // Both fold onto Ctrl if you are not careful, and then Raycast's
    // ⌘⌃↵ ("Create and Open Folder") swallows plain ⌘↵. Ctrl+Super is the
    // Linux reading of the two-modifier combination.
    const cmdCtrlEnter = parseShortcut({ modifiers: ['cmd', 'ctrl'], key: 'enter' })!

    expect(matchesShortcut(keydown('Enter', { ctrlKey: true }), cmdCtrlEnter)).toBe(false)
    expect(matchesShortcut(keydown('Enter', { ctrlKey: true, metaKey: true }), cmdCtrlEnter)).toBe(true)
    expect(matchesShortcut(keydown('Enter', { ctrlKey: true, metaKey: true }), cmdEnter)).toBe(false)
  })

  it('requires the key itself to match', () => {
    expect(matchesShortcut(keydown('k', { ctrlKey: true }), cmdEnter)).toBe(false)
  })
})

describe('actionsFromSlot', () => {
  /** The shape `Create Extension` builds: one panel, four submit actions. */
  function createExtensionPanel(): { slot: UiNode; nodes: Record<string, UiNode> } {
    const titles: [string, string[]][] = [
      ['Create Extension', ['cmd']],
      ['Create and Open in Editor', ['cmd', 'shift']],
      ['Create and Open Folder', ['cmd', 'ctrl']],
      ['Create and Copy Folder Path', ['cmd', 'opt']],
    ]
    const nodes: Record<string, UiNode> = {}
    const actionIds = titles.map(([title, modifiers], index) => {
      const id = `action-${index}`
      nodes[id] = {
        id,
        type: 'Action',
        props: { title, __variant: 'submit-form', shortcut: { modifiers, key: 'enter' } },
        children: [],
      }
      return id
    })
    nodes.panel = { id: 'panel', type: 'ActionPanel', props: {}, children: actionIds }
    const slot: UiNode = { id: 'slot', type: '__actions', props: {}, children: ['panel'] }
    nodes.slot = slot
    return { slot, nodes }
  }

  it('lists every action in the panel, not just the first', () => {
    const { slot, nodes } = createExtensionPanel()

    expect(actionsFromSlot(slot, nodes).map((action) => action.title)).toEqual([
      'Create Extension',
      'Create and Open in Editor',
      'Create and Open Folder',
      'Create and Copy Folder Path',
    ])
  })

  it('renders each shortcut with the symbols the menu shows', () => {
    const { slot, nodes } = createExtensionPanel()

    expect(actionsFromSlot(slot, nodes).map((action) => action.shortcut)).toEqual(['⌘↵', '⌘⇧↵', '⌘⌃↵', '⌘⌥↵'])
  })

  it('finds the actions slot among a component’s children', () => {
    const nodes: Record<string, UiNode> = {
      slot: { id: 'slot', type: '__actions', props: {}, children: [] },
      other: { id: 'other', type: 'Form.TextField', props: {}, children: [] },
    }
    const form: UiNode = { id: 'form', type: 'Form', props: {}, children: ['other', 'slot'] }

    expect(findActionsSlot(form, nodes)?.id).toBe('slot')
  })
})
