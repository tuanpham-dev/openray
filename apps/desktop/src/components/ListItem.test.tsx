import { afterEach, describe, expect, it } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { ListItem } from './ListItem'
import type { PaletteItem } from './types'

/**
 * The scanner now carries an app's own description ("Browse the World Wide
 * Web") instead of always the generic "Application" label. Squeezed onto
 * the title's line it either crowds the title out or gets cut to nothing —
 * this covers giving it a second line instead, the same treatment an
 * extension's own `layout="detailed"` rows already get.
 */

let container: HTMLDivElement | null = null
let root: Root | null = null

function render(item: PaletteItem) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(<ListItem item={item} selected={false} onSelect={() => {}} onActivate={() => {}} />)
  })
  return container
}

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
})

function app(overrides: Partial<PaletteItem>): PaletteItem {
  return { id: 'firefox.desktop', title: 'Firefox', kind: 'app', ...overrides }
}

describe('ListItem app descriptions', () => {
  it('stacks an app with a real description onto a second line', () => {
    const row = render(app({ subtitle: 'Browse the World Wide Web' }))

    expect(row.querySelector('.openray-list-item')?.className).toContain('openray-list-item--detailed')
    expect(row.querySelector('.openray-list-item-subtitle')?.textContent).toBe('Browse the World Wide Web')
  })

  it('shows neither a subtitle nor the two-line layout for an app with no description', () => {
    const row = render(app({ subtitle: 'Application' }))

    expect(row.querySelector('.openray-list-item')?.className).not.toContain('openray-list-item--detailed')
    expect(row.querySelector('.openray-list-item-subtitle')).toBeNull()
  })

  it('leaves a non-app row single-line even when it carries a subtitle', () => {
    // Scope is deliberately apps only — a builtin's or extension command's
    // own subtitle keeps its existing inline treatment.
    const row = render({ id: 'settings', title: 'OpenRay Settings', kind: 'builtin', subtitle: 'Built-in Command' })

    expect(row.querySelector('.openray-list-item')?.className).not.toContain('openray-list-item--detailed')
  })

  it('keeps an alias beside the icon rather than swallowed into the stacked lines', () => {
    const row = render(app({ subtitle: 'Browse the World Wide Web', alias: 'ff' }))

    const alias = row.querySelector('.openray-list-item-alias')
    expect(alias).not.toBeNull()
    expect(alias?.closest('.openray-list-item-main')).toBeNull()
  })

  it('keeps an alias inline with the title when the row is single-line', () => {
    const row = render(app({ subtitle: 'Application', alias: 'ff' }))

    const alias = row.querySelector('.openray-list-item-alias')
    expect(alias?.closest('.openray-list-item-main')).not.toBeNull()
  })
})
