import type { ComponentType } from 'react'
import {
  AlertIcon,
  AppWindowIcon,
  ArrowRightIcon,
  BluetoothIcon,
  CalculatorIcon,
  CameraIcon,
  CheckCircleIcon,
  ClipboardIcon,
  CloseIcon,
  CodeIcon,
  CopyIcon,
  CrosshairIcon,
  DownloadIcon,
  ExternalLinkIcon,
  EyeIcon,
  EyeOffIcon,
  PencilIcon,
  PinIcon,
  PlusIcon,
  DisplayNextIcon,
  DisplayPreviousIcon,
  DragIcon,
  FileIcon,
  FolderIcon,
  GearIcon,
  HashIcon,
  LinkIcon,
  LockIcon,
  MailIcon,
  LogOutIcon,
  MonitorIcon,
  MonitorOffIcon,
  MoonIcon,
  NoteIcon,
  PlayPauseIcon,
  PowerIcon,
  RefreshIcon,
  ScissorsIcon,
  SearchIcon,
  SendIcon,
  SkipBackIcon,
  SkipForwardIcon,
  SmileyIcon,
  SparklesIcon,
  SwapIcon,
  SystemThemeIcon,
  TextIcon,
  TranslateIcon,
  TrashIcon,
  Volume1Icon,
  Volume2Icon,
  VolumeIcon,
  VolumeXIcon,
  WindowAlmostMaximizeIcon,
  WindowBottomHalfIcon,
  WindowCenterIcon,
  WindowFullscreenIcon,
  WindowLargerIcon,
  WindowLeftHalfIcon,
  WindowMaximizeHeightIcon,
  WindowMaximizeIcon,
  WindowMaximizeWidthIcon,
  WindowMoveIcon,
  WindowQuarterIcon,
  WindowReasonableSizeIcon,
  WindowRestoreIcon,
  WindowRightHalfIcon,
  WindowSixthIcon,
  WindowSmallerIcon,
  WindowThirdIcon,
  WindowTopHalfIcon,
  WindowTwoThirdsIcon,
} from './icons'

interface IconProps {
  size?: number
  className?: string
}

/**
 * Kebab-case names for first-party icons, mapped to the app's own
 * monoline SVG set — individual command icons (system commands, Window
 * Management, the built-in "OpenRay Settings" command), whole built-in
 * extensions' own manifest icons (`extensions/*\/package.json`'s
 * `"icon"`, read via `ExtensionsRegistry`/`Command.icon`'s server-side
 * fallback — see `extension_commands.rs`/`root_commands.rs`), and static
 * rows a first-party extension's own mounted view renders (e.g. AI
 * chat's "Send"/"Error" `List.Item`s — see `VisualContent` in
 * `TreeRenderer.tsx`, which consults this map the same way `IconGlyph`
 * does). Rows backed by external/user content (script commands, user
 * quicklinks/snippets, clipboard entries) instead carry a literal glyph
 * — an emoji or an image path — through `icon` unchanged; there's no
 * single "right" SVG for arbitrary user content, so those never need an
 * entry here. The "emoji" extension is first-party chrome, not user
 * content, so its manifest icon is the `smiley` name below rather than a
 * literal 🙂 — the reason in the next paragraph applied to it too.
 *
 * A symbolic name rather than a literal emoji glyph: the OS emoji font
 * renders each glyph in that font's own style and color (compare
 * `assets/audio-mute.png` red-and-white vs. a plain white power symbol —
 * they read as two different icon systems side by side), where these are
 * first-party UI and should look like the rest of the app's chrome.
 */
export const SYSTEM_ICON_NAMES: Record<string, ComponentType<IconProps>> = {
  lock: LockIcon,
  moon: MoonIcon,
  refresh: RefreshIcon,
  power: PowerIcon,
  'log-out': LogOutIcon,
  'monitor-off': MonitorOffIcon,
  monitor: MonitorIcon,
  sparkles: SparklesIcon,
  'play-pause': PlayPauseIcon,
  'skip-forward': SkipForwardIcon,
  'skip-back': SkipBackIcon,
  'volume-x': VolumeXIcon,
  volume: VolumeIcon,
  'volume-1': Volume1Icon,
  'volume-2': Volume2Icon,
  trash: TrashIcon,
  bluetooth: BluetoothIcon,
  'system-theme': SystemThemeIcon,
  'window-left-half': WindowLeftHalfIcon,
  'window-right-half': WindowRightHalfIcon,
  'window-top-half': WindowTopHalfIcon,
  'window-bottom-half': WindowBottomHalfIcon,
  'window-quarter': WindowQuarterIcon,
  'window-sixth': WindowSixthIcon,
  'window-third': WindowThirdIcon,
  'window-two-thirds': WindowTwoThirdsIcon,
  'window-maximize': WindowMaximizeIcon,
  'window-almost-maximize': WindowAlmostMaximizeIcon,
  'window-maximize-height': WindowMaximizeHeightIcon,
  'window-maximize-width': WindowMaximizeWidthIcon,
  'window-reasonable-size': WindowReasonableSizeIcon,
  'window-center': WindowCenterIcon,
  'window-restore': WindowRestoreIcon,
  'window-larger': WindowLargerIcon,
  'window-smaller': WindowSmallerIcon,
  'window-move': WindowMoveIcon,
  'display-next': DisplayNextIcon,
  'display-previous': DisplayPreviousIcon,
  'window-fullscreen': WindowFullscreenIcon,
  'app-window': AppWindowIcon,
  camera: CameraIcon,
  file: FileIcon,
  folder: FolderIcon,
  text: TextIcon,
  mail: MailIcon,
  hash: HashIcon,
  search: SearchIcon,
  drag: DragIcon,
  calculator: CalculatorIcon,
  link: LinkIcon,
  scissors: ScissorsIcon,
  clipboard: ClipboardIcon,
  smiley: SmileyIcon,
  note: NoteIcon,
  code: CodeIcon,
  translate: TranslateIcon,
  settings: GearIcon,
  send: SendIcon,
  alert: AlertIcon,
  'arrow-right': ArrowRightIcon,
  'check-circle': CheckCircleIcon,
  copy: CopyIcon,
  'external-link': ExternalLinkIcon,
  eye: EyeIcon,
  'eye-slash': EyeOffIcon,
  plus: PlusIcon,
  pencil: PencilIcon,
  download: DownloadIcon,
  pin: PinIcon,
  swap: SwapIcon,
  crosshair: CrosshairIcon,
  close: CloseIcon,
}

/**
 * Raycast `Icon` values mapped onto the glyphs this app actually ships.
 *
 * Extensions reference icons by name (`Icon.MagnifyingGlass` is the string
 * `"magnifying-glass"`), and Raycast's set is far larger than ours. Names
 * with a real counterpart are aliased here; the rest are handled by
 * `looksLikeIconName` below, which is what stops an unmatched name being
 * printed as literal text — `hacker-news` rendered "arrow-up-circle 5"
 * beside every story instead of an upvote count.
 */
export const RAYCAST_ICON_ALIASES: Record<string, string> = {
  'magnifying-glass': 'search',
  document: 'file',
  'save-document': 'file',
  gear: 'settings',
  terminal: 'code',
  window: 'app-window',
  'exclamation-mark': 'alert',
  warning: 'alert',
  info: 'alert',
  'question-mark': 'alert',
  upload: 'send',
  globe: 'link',
  'xmark-circle': 'close',
  // A window with its right pane picked out is the nearest thing this set
  // has to Raycast's sidebar glyph.
  'app-window-sidebar-right': 'window-right-half',
  'copy-clipboard': 'copy',
}

/**
 * The glyph for an icon name, or `undefined` when this app ships none.
 *
 * Tries the name as written, then its alias, then the same two again with
 * Raycast's size and variant suffixes peeled off. Every value in the real
 * `Icon` enum carries a `-16` (`Trash = "trash-16"`), and a family with
 * several designs also carries a variant number (`Globe = "globe-01-16"`).
 * Extensions that use the enum are unaffected either way — this shim's own
 * values are unsuffixed — but the prop accepts any string, so an extension
 * that hardcodes `icon="trash-16"` would otherwise resolve to nothing.
 *
 * The exact name always wins, so a first-party name that genuinely ends in
 * a number (`volume-1`, `window-two-thirds`) is never mistaken for a
 * suffixed one.
 */
export function lookupSystemIcon(name: string): ComponentType<IconProps> | undefined {
  let candidate = name
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const direct = SYSTEM_ICON_NAMES[candidate]
    if (direct) return direct
    const aliased = RAYCAST_ICON_ALIASES[candidate]
    if (aliased && SYSTEM_ICON_NAMES[aliased]) return SYSTEM_ICON_NAMES[aliased]
    const trimmed = candidate.replace(/-\d+$/, '')
    if (trimmed === candidate) return undefined
    candidate = trimmed
  }
  return undefined
}

/**
 * Whether a string is an *icon identifier* rather than something meant to
 * be displayed.
 *
 * Icon props accept a glyph (an emoji) as well as a name, so the renderer
 * cannot simply refuse to draw unknown strings — it has to tell the two
 * apart. Kebab-case ASCII is a name; anything else (an emoji, a word with
 * spaces) is content. Also catches the `[openray stub: …]` marker an
 * unimplemented API stringifies to, which is never something to show a
 * user.
 */
export function looksLikeIconName(value: string): boolean {
  return value.startsWith('[openray stub:') || /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(value)
}
