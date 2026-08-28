/**
 * Plain string constants — Raycast's real Icon enum has ~300 entries; this
 * covers the ones touched by the T19b/T20 spike plus a reasonably common
 * subset. Add more as real extensions need them (COMPAT.md's "try
 * extension -> add missing API" loop) rather than enumerating all of them
 * speculatively.
 */
export const Icon = {
  SaveDocument: 'save-document',
  ArrowUpCircle: 'arrow-up-circle',
  Bubble: 'bubble',
  Circle: 'circle',
  CheckCircle: 'check-circle',
  XMarkCircle: 'xmark-circle',
  Clipboard: 'clipboard',
  Globe: 'globe',
  Link: 'link',
  Document: 'document',
  Folder: 'folder',
  Gear: 'gear',
  MagnifyingGlass: 'magnifying-glass',
  Star: 'star',
  Trash: 'trash',
  Pencil: 'pencil',
  Plus: 'plus',
  Minus: 'minus',
  ExclamationMark: 'exclamation-mark',
  QuestionMark: 'question-mark',
  Info: 'info',
  Warning: 'warning',
  Terminal: 'terminal',
  Code: 'code',
  Person: 'person',
  Clock: 'clock',
  Calendar: 'calendar',
  Download: 'download',
  Upload: 'upload',
  ArrowRight: 'arrow-right',
  ArrowLeft: 'arrow-left',
  Eye: 'eye',
  EyeSlash: 'eye-slash',
  // Referenced by `wikipedia`; a missing member is not inert — the action
  // ends up with `icon={undefined}` and silently renders no icon at all.
  Window: 'window',
  AppWindowSidebarRight: 'app-window-sidebar-right',
  Image: 'image',
} as const

/**
 * Raycast's `Image` namespace, as far as an extension uses it at runtime:
 * `Image.Mask` values passed to an icon prop. A missing nested enum is not
 * cosmetic — the property access throws mid-render and takes the whole
 * command down, the same failure `Grid.Fit` and `Action.Style` were added
 * for.
 */
export const Image = {
  Mask: { Circle: 'circle', RoundedRectangle: 'roundedRectangle' },
} as const

export const Color = {
  Blue: '#0A84FF',
  Green: '#30D158',
  Red: '#FF453A',
  Yellow: '#FFD60A',
  Orange: '#FF9F0A',
  Purple: '#BF5AF2',
  Magenta: '#FF375F',
  PrimaryText: '#FFFFFF',
  SecondaryText: '#8E8E93',
} as const
