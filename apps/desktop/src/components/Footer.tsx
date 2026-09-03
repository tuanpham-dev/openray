import { useEffect, useRef, useState, type ReactNode } from 'react'
import { IconGlyph } from './IconGlyph'
import { GearIcon } from './icons'
import { registerOverlay } from './overlay'
import { openExtensionSettings, openSettings } from '../ipc/settings'
import { hidePalette } from '../ipc/window'

interface FooterProps {
  primaryActionLabel?: string
  /** True for a Form's submit action, the one case whose primary action
   *  actually fires on ⌘↵ rather than plain ↵ (see `ExtensionForm`'s
   *  key handler in `TreeRenderer.tsx` — plain Enter has to stay free for
   *  a text field's own editing, unlike a List/Grid row). Found live:
   *  the hint read "Create Quicklink ↵" and plain Enter silently did
   *  nothing, since it actually needed ⌘↵ — the hint just never said so. */
  primaryActionNeedsCmd?: boolean
  /** Name of the current sub-view, shown in place of the app name — the
   *  way Raycast labels the footer with the running command. */
  context?: string
  /** The running command's own icon (its manifest `icon`, already
   *  resolved server-side — see `ListItem.tsx`'s `ItemIcon` comment).
   *  Only meaningful alongside `context`; ignored otherwise. */
  contextIcon?: string | null
  /** The running extension, when `context` names one of its commands.
   *  Switches the brand menu from "Open Settings" to the extension's own
   *  settings page. */
  extensionId?: string
}

interface FooterMenuItem {
  id: string
  title: string
  icon: ReactNode
  shortcut?: string
  run: () => Promise<void>
}

export function Footer({ primaryActionLabel = 'Open', primaryActionNeedsCmd = false, context, contextIcon, extensionId }: FooterProps) {
  const menuItems: FooterMenuItem[] = extensionId
    ? [{ id: 'extension-settings', title: 'Open Extension Settings', icon: <GearIcon size={15} />, run: () => openExtensionSettings(extensionId) }]
    : [{ id: 'settings', title: 'Open Settings', icon: <GearIcon size={15} />, shortcut: '⌘,', run: () => openSettings() }]

  return (
    <div className="openray-footer">
      <FooterMenu items={menuItems} label={context ?? 'OpenRay'}>
        <IconGlyph
          icon={context ? contextIcon : undefined}
          size={16}
          svgClassName="openray-footer-brand-icon-svg"
          imageClassName="openray-footer-brand-icon-image"
          textClassName="openray-footer-brand-icon-text"
          fallback={<img className="openray-footer-brand-mark" src="/favicon.svg" alt="" />}
        />
        {context ?? 'OpenRay'}
      </FooterMenu>
      <div className="openray-footer-actions">
        <span className="openray-footer-hint">
          {primaryActionLabel} {primaryActionNeedsCmd && <kbd>⌘</kbd>}
          <kbd>↵</kbd>
        </span>
        <span className="openray-footer-divider" />
        <span className="openray-footer-hint">
          Actions <kbd>⌘</kbd>
          <kbd>K</kbd>
        </span>
      </div>
    </div>
  )
}

/**
 * The footer's brand label doubles as a menu button, the way Raycast's
 * does: the root palette offers Settings, a running extension command its
 * own extension's settings page.
 *
 * Same popover vocabulary as `FilterSelect` (and for the same reasons —
 * see its doc comment): chrome-less trigger, the menu carrying the only
 * border, keyboard-driven while open with its keys claimed on the capture
 * phase so the list underneath doesn't also act on them. The palette hides
 * after a pick, since every item opens a window of its own.
 */
function FooterMenu({ items, label, children }: { items: FooterMenuItem[]; label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)

  const pick = (item: FooterMenuItem | undefined) => {
    setOpen(false)
    if (!item) return
    void item.run()
    void hidePalette()
  }

  // Escape closes the menu instead of navigating back out of the command —
  // the same claim `ActionPanel` and `FilterSelect` make.
  useEffect(() => {
    if (!open) return
    return registerOverlay()
  }, [open])

  useEffect(() => {
    if (!open) return

    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }

    const onKeyDown = (event: KeyboardEvent) => {
      const claim = () => {
        event.preventDefault()
        event.stopPropagation()
        // The view underneath listens on this same `window`; only this
        // skips its listeners too.
        event.stopImmediatePropagation()
      }

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        claim()
        const direction = event.key === 'ArrowDown' ? 1 : -1
        setActiveIndex((index) => (index + direction + items.length) % items.length)
      } else if (event.key === 'Enter') {
        claim()
        pick(items[activeIndex])
      } else if (event.key === 'Escape') {
        claim()
        setOpen(false)
      }
    }

    window.addEventListener('mousedown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('mousedown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown, true)
    }
    // `pick` closes over nothing that changes while the menu is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, items, activeIndex])

  return (
    <div className="openray-footer-menu-root" ref={rootRef}>
      <button
        type="button"
        className={`openray-footer-brand${open ? ' openray-footer-brand--open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${label} menu`}
        // Never take focus: the search field keeps it, so typing still
        // reaches the query after the menu has been used with a pointer.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          setActiveIndex(0)
          setOpen((isOpen) => !isOpen)
        }}
      >
        {children}
      </button>

      {open && (
        <div className="openray-footer-menu" role="menu" aria-label={`${label} menu`}>
          {items.map((item, index) => (
            <div
              key={item.id}
              role="menuitem"
              className={`openray-action-item${index === activeIndex ? ' openray-action-item--selected' : ''}`}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => pick(item)}
            >
              <span className="openray-action-item-icon">{item.icon}</span>
              <span className="openray-action-item-title">{item.title}</span>
              {item.shortcut && <kbd className="openray-action-item-shortcut">{item.shortcut}</kbd>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
