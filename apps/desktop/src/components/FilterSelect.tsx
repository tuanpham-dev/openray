import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDownIcon } from './icons'
import { registerOverlay } from './overlay'

export interface FilterOption<T extends string> {
  value: T
  label: string
}

interface FilterSelectProps<T extends string> {
  options: FilterOption<T>[]
  value: T
  onChange: (value: T) => void
  label: string
  /** Lets the owning view stand down its own list navigation while the
   *  menu owns the keyboard — the same thing it does for the ⌘K actions
   *  panel. Relying on `stopPropagation` alone isn't enough: both handlers
   *  live on `window`, so which one sees the key first comes down to
   *  registration order. */
  onOpenChange?: (open: boolean) => void
}

/**
 * The compact category filter at the trailing edge of a search bar (a
 * `List.Dropdown` accessory).
 *
 * Hand-rolled rather than a native `<select>`, and deliberately chrome-less
 * — Raycast draws it as plain label + chevron, with the menu itself
 * carrying the only border, the same popover the ⌘K actions panel uses. A
 * native select can't be styled that way (WebKitGTK draws its popup with
 * platform chrome that ignores the app's theme), and its own borders read
 * as a second input beside the search field.
 *
 * Fully keyboard-driven, since the pointer is the exception in a launcher:
 * ⌘P (or ⌃P) opens and closes it, ↑/↓ move the highlight, ↵ picks, Escape
 * closes without changing anything. Those keys are claimed on the capture
 * phase while the menu is open, so the list underneath doesn't also move
 * its own selection on the same press.
 *
 * The menu is absolutely positioned inside the palette, not `fixed`, so it
 * opens within the window without having to escape a scroll container.
 */
export function FilterSelect<T extends string>({ options, value, onChange, label, onOpenChange }: FilterSelectProps<T>) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLUListElement>(null)
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  )
  const current = options[selectedIndex]

  // Opening always starts from what's currently selected, however the menu
  // was opened.
  const openMenu = useCallback(() => {
    setActiveIndex(selectedIndex)
    setOpen(true)
  }, [selectedIndex])

  // Signals to the view underneath that Escape belongs to this menu — the
  // same claim `ActionPanel` makes, so Escape closes the menu instead of
  // navigating back out of the command.
  useEffect(() => {
    if (!open) return
    return registerOverlay()
  }, [open])

  useEffect(() => {
    onOpenChange?.(open)
    // Only the open/closed transition matters; a parent passing a fresh
    // callback each render shouldn't refire this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // ⌘P/⌃P toggles the menu — the one binding that has to work while the
  // menu is closed, so it lives outside the open-only handler below.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && (event.key === 'p' || event.key === 'P')) {
        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation()
        setOpen((isOpen) => {
          if (!isOpen) setActiveIndex(selectedIndex)
          return !isOpen
        })
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [selectedIndex])

  useEffect(() => {
    if (!open) return

    // Capture phase, so the menu closes even when the click lands on
    // something that stops propagation on its way up.
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }

    const onKeyDown = (event: KeyboardEvent) => {
      const move = (direction: 1 | -1) => setActiveIndex((index) => (index + direction + options.length) % options.length)

      const claim = () => {
        event.preventDefault()
        event.stopPropagation()
        // Not just stopPropagation: the list underneath listens on the very
        // same `window`, where stopping propagation doesn't skip the other
        // listeners already attached to it.
        event.stopImmediatePropagation()
      }

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        claim()
        move(event.key === 'ArrowDown' ? 1 : -1)
      } else if (event.key === 'Home' || event.key === 'End') {
        claim()
        setActiveIndex(event.key === 'Home' ? 0 : options.length - 1)
      } else if (event.key === 'Enter' || event.key === 'Tab') {
        claim()
        const option = options[activeIndex]
        if (option) onChange(option.value)
        setOpen(false)
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
  }, [open, options, activeIndex, onChange])

  // Keep the highlighted option on screen — the category list is longer
  // than the menu's max height.
  useEffect(() => {
    if (!open) return
    menuRef.current?.children[activeIndex]?.querySelector('button')?.scrollIntoView({ block: 'nearest' })
  }, [open, activeIndex])

  return (
    <div className="openray-filter-select" ref={rootRef}>
      <button
        type="button"
        className={`openray-filter-select-button${open ? ' openray-filter-select-button--open' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        // Never take focus: the search field keeps it, so typing still
        // reaches the query after the filter has been used with a pointer.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => (open ? setOpen(false) : openMenu())}
      >
        <span className="openray-filter-select-value">{current?.label}</span>
        <ChevronDownIcon size={12} />
      </button>

      {open && (
        <ul className="openray-filter-select-menu" role="listbox" aria-label={label} ref={menuRef}>
          {options.map((option, index) => (
            <li key={option.value}>
              <button
                type="button"
                role="option"
                aria-selected={option.value === value}
                className={`openray-filter-select-option${index === activeIndex ? ' openray-filter-select-option--active' : ''}${
                  option.value === value ? ' openray-filter-select-option--selected' : ''
                }`}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => {
                  onChange(option.value)
                  setOpen(false)
                }}
              >
                {option.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
