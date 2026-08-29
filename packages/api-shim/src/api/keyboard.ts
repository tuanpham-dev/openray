export interface KeyboardShortcut {
  modifiers: string[]
  key: string
}

/**
 * Raycast's shared shortcut vocabulary.
 *
 * Extensions reference these rather than spelling out modifiers —
 * `shortcut={Keyboard.Shortcut.Common.Remove}` — and 37 of 180 sampled
 * extensions import `Keyboard`. It was a stub, so every one of those
 * shortcuts was silently inert: the action row showed no key hint and the
 * key did nothing.
 *
 * The values are Raycast's **macOS** table. `matchesShortcut` in the
 * renderer already maps `cmd` onto Ctrl here, so taking Raycast's Windows
 * column instead would translate twice.
 *
 * Two entries deliberately diverge from Raycast because its macOS binding
 * collides with a standard Linux one: `Remove` is ⌘⌫ rather than ⌃X (which
 * is Cut everywhere on this platform), and `RemoveAll` follows it. An
 * extension's own README will name the Raycast binding for those two.
 */
const Common = {
  Copy: { modifiers: ['cmd', 'shift'], key: 'c' },
  CopyDeeplink: { modifiers: ['cmd', 'shift'], key: 'c' },
  CopyName: { modifiers: ['cmd', 'shift'], key: '.' },
  CopyPath: { modifiers: ['cmd', 'shift'], key: ',' },
  Save: { modifiers: ['cmd'], key: 's' },
  Duplicate: { modifiers: ['cmd'], key: 'd' },
  Edit: { modifiers: ['cmd'], key: 'e' },
  MoveDown: { modifiers: ['cmd', 'shift'], key: 'arrowDown' },
  MoveUp: { modifiers: ['cmd', 'shift'], key: 'arrowUp' },
  New: { modifiers: ['cmd'], key: 'n' },
  Open: { modifiers: ['cmd'], key: 'o' },
  OpenWith: { modifiers: ['cmd', 'shift'], key: 'o' },
  Pin: { modifiers: ['cmd', 'shift'], key: 'p' },
  Refresh: { modifiers: ['cmd'], key: 'r' },
  Remove: { modifiers: ['cmd'], key: 'backspace' },
  RemoveAll: { modifiers: ['cmd', 'shift'], key: 'backspace' },
  ToggleQuickLook: { modifiers: ['cmd'], key: 'y' },
} as const satisfies Record<string, KeyboardShortcut>

export const Keyboard = {
  Shortcut: { Common },
} as const
