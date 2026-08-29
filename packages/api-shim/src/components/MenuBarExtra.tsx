import { createElement, type ReactElement, type ReactNode } from 'react'
import { NodeType } from '../node-types'
import { withFallbacks } from './namespace-fallback'

/**
 * Raycast's menu-bar command surface.
 *
 * A `menu-bar` command's default export returns one of these instead of a
 * `List`/`Detail`, and its contents belong in the system tray rather than
 * the palette. This module only builds the tree; turning it into a real
 * tray icon is the Rust side's job (`application::menu_bar`).
 *
 * Until then the components still have to *exist*: `MenuBarExtra` was a
 * module-level stub, so `MenuBarExtra.Item` was `undefined` and React threw
 * "Element type is invalid" — 19 of 180 sampled extensions have a menu-bar
 * command, and every one of them failed to mount over it.
 */
export interface MenuBarExtraProps {
  isLoading?: boolean
  title?: string
  tooltip?: string
  icon?: unknown
  children?: ReactNode
}

function MenuBarExtraBase(props: MenuBarExtraProps): ReactElement {
  const { children, ...rest } = props
  return createElement(NodeType.MenuBarExtra, rest, children)
}

export interface MenuBarExtraItemProps {
  title: string
  subtitle?: string
  icon?: unknown
  tooltip?: string
  shortcut?: { modifiers: string[]; key: string }
  /** Raycast passes an event describing how the item was activated; the
   *  tray only ever produces a left-click, so callers receive that. */
  onAction?: (event: { type: 'left-click' }) => void
}
function MenuBarExtraItem(props: MenuBarExtraItemProps): ReactElement {
  return createElement(NodeType.MenuBarExtraItem, props)
}

export interface MenuBarExtraSectionProps {
  title?: string
  children?: ReactNode
}
function MenuBarExtraSection(props: MenuBarExtraSectionProps): ReactElement {
  const { children, ...rest } = props
  return createElement(NodeType.MenuBarExtraSection, rest, children)
}

export interface MenuBarExtraSubmenuProps {
  title: string
  icon?: unknown
  children?: ReactNode
}
function MenuBarExtraSubmenu(props: MenuBarExtraSubmenuProps): ReactElement {
  const { children, ...rest } = props
  return createElement(NodeType.MenuBarExtraSubmenu, rest, children)
}

MenuBarExtraBase.Item = MenuBarExtraItem
MenuBarExtraBase.Section = MenuBarExtraSection
MenuBarExtraBase.Submenu = MenuBarExtraSubmenu

/**
 * An unimplemented `MenuBarExtra.*` member renders nothing — a tray menu
 * has no inert visual slot to put a note in, and the menu is built by
 * walking for known node types anyway.
 */
const menuBarExtraWithFallbacks = withFallbacks(MenuBarExtraBase, () => {
  return (): null => null
})

/** The `MenuBarExtra` extensions actually see. */
export const MenuBarExtra = menuBarExtraWithFallbacks
