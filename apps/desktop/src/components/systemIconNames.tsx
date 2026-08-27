import type { ComponentType } from 'react'
import {
  AlertIcon,
  AppWindowIcon,
  BluetoothIcon,
  CalculatorIcon,
  CameraIcon,
  ClipboardIcon,
  CodeIcon,
  DisplayNextIcon,
  DisplayPreviousIcon,
  DragIcon,
  GearIcon,
  LinkIcon,
  LockIcon,
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
  SparklesIcon,
  SystemThemeIcon,
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
 * quicklinks/snippets, clipboard entries, the "emoji" extension's own
 * icon) instead carry a literal glyph — an emoji or an image path —
 * through `icon` unchanged; there's no single "right" SVG for arbitrary
 * user content, so those never need an entry here.
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
  search: SearchIcon,
  drag: DragIcon,
  calculator: CalculatorIcon,
  link: LinkIcon,
  scissors: ScissorsIcon,
  clipboard: ClipboardIcon,
  note: NoteIcon,
  code: CodeIcon,
  translate: TranslateIcon,
  settings: GearIcon,
  send: SendIcon,
  alert: AlertIcon,
}
