import { createElement, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ArgumentFields, type ArgumentFieldsHandle } from './ArgumentFields'
import type { CommandArgument } from './types'

/**
 * The palette listens for keys on `window` to activate the selected row.
 * A key the argument fields handle must not also reach that listener —
 * when Enter did, the command ran twice and `capture-note` wrote two
 * identical notes a millisecond apart.
 */

const ARGS: CommandArgument[] = [
  { name: 'text', type: 'text', placeholder: 'Note text', required: true },
  { name: 'tag', type: 'text', placeholder: 'Tag', required: false },
]

let container: HTMLDivElement | undefined

function render(props: Partial<Parameters<typeof ArgumentFields>[0]> = {}) {
  container = document.createElement('div')
  document.body.append(container)
  const ref = createRef<ArgumentFieldsHandle>()
  const onSubmit = vi.fn()
  const onChange = vi.fn()
  const onExit = vi.fn()
  const root = createRoot(container)
  act(() => {
    root.render(
      createElement(ArgumentFields, {
        ref,
        args: ARGS,
        values: { text: 'a note' },
        onChange,
        onSubmit,
        onExit,
        ...props,
      }),
    )
  })
  const inputs = [...container.querySelectorAll('input')]
  return { inputs, onSubmit, onChange, onExit, ref }
}

function press(element: Element, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  element.dispatchEvent(event)
  return event
}

afterEach(() => {
  container?.remove()
  container = undefined
})

describe('ArgumentFields', () => {
  it('renders one field per declared argument, using its placeholder', () => {
    const { inputs } = render()
    expect(inputs).toHaveLength(2)
    expect(inputs[0]?.placeholder).toBe('Note text')
    expect(inputs[1]?.placeholder).toBe('Tag')
  })

  it('marks a required field so it can be styled as unfinished', () => {
    const { inputs } = render()
    expect(inputs[0]?.dataset.required).toBe('true')
    expect(inputs[1]?.dataset.required).toBeUndefined()
  })

  it('submits on Enter and stops the key reaching the window listener', () => {
    const onWindowKeyDown = vi.fn()
    window.addEventListener('keydown', onWindowKeyDown)
    try {
      const { inputs, onSubmit } = render()
      press(inputs[0]!, 'Enter')
      expect(onSubmit).toHaveBeenCalledTimes(1)
      // The whole point: the palette's own Enter handling must not also
      // fire, or the command runs twice.
      expect(onWindowKeyDown).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', onWindowKeyDown)
    }
  })

  it('moves between fields with Tab without letting it escape the bar', () => {
    const onWindowKeyDown = vi.fn()
    window.addEventListener('keydown', onWindowKeyDown)
    try {
      const { inputs } = render()
      inputs[0]?.focus()
      press(inputs[0]!, 'Tab')
      expect(document.activeElement).toBe(inputs[1])
      press(inputs[1]!, 'Tab', { shiftKey: true })
      expect(document.activeElement).toBe(inputs[0])
      expect(onWindowKeyDown).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', onWindowKeyDown)
    }
  })

  it('hands focus back to the query when moving left off the first field', () => {
    const { inputs, onExit } = render()
    inputs[0]?.focus()
    inputs[0]!.setSelectionRange(0, 0)
    press(inputs[0]!, 'ArrowLeft')
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('leaves up/down alone so the list selection still moves', () => {
    const onWindowKeyDown = vi.fn()
    window.addEventListener('keydown', onWindowKeyDown)
    try {
      const { inputs } = render()
      press(inputs[0]!, 'ArrowDown')
      expect(onWindowKeyDown).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('keydown', onWindowKeyDown)
    }
  })

  it('focuses a field on demand, for the required-but-empty case', () => {
    const { inputs, ref } = render()
    act(() => ref.current?.focus(1))
    expect(document.activeElement).toBe(inputs[1])
  })
})
