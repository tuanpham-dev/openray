import { invoke } from '@tauri-apps/api/core'

export type WindowSize = 'small' | 'medium' | 'large'

export interface Settings {
  hotkey: string
  theme: 'system' | 'light' | 'dark'
  launchAtLogin: boolean
  windowSize: WindowSize
  /** Palette background opacity, 0.3–1.0 (clamped backend-side). */
  opacity: number
  shadow: boolean
  /** Vim-style Alt+J / Alt+K as an alternative to the arrow keys. */
  altJkNavigation: boolean
  /** Directories scanned for Raycast-style script commands. */
  scriptDirectories: string[]
  /** Pixel gap Window Management's tiling presets and Maximize leave
   *  around and between windows, 0–64 (clamped backend-side). */
  windowGap: number
  /** Whether repeatedly pressing the same Half preset cycles the window's
   *  size through ½ → ⅔ → ⅓ instead of repeating the same size. */
  halfCycling: boolean
  /** Folders Screenshots scans for images/videos. `~/` is expanded backend-side. */
  screenshotSearchScopes: string[]
  /** File extensions (no leading dot) Screenshots treats as video. */
  screenshotVideoExtensions: string[]
  /** Grid column count, 3–6 (clamped backend-side). */
  screenshotGridColumns: number
  /** Whether the background OCR sweep runs at all. */
  screenshotOcrEnabled: boolean
  /** What Paste/Copy put on the clipboard by default. The grid's action
   *  panel can still override this per-action regardless of the setting. */
  screenshotPasteFormat: 'auto' | 'image' | 'file' | 'path'
  /** Remembered/default target language for the Translate view — a gtx
   *  language code (see `ipc/translate.ts`'s `Language`). */
  translateTargetLanguage: string
  /** Default source language for the Translate view — `"auto"` (detect)
   *  or a gtx language code. */
  translateSourceLanguage: string
  /** What Translate's primary action (↵) does with the translated text. */
  translatePrimaryAction: 'copy' | 'paste'
  /** Whether translations are recorded to history. */
  translateHistoryEnabled: boolean
  /** Whether the notes window stays above other windows. */
  notesAlwaysOnTop: boolean
  /** Default chat model, `<provider>:<model>`. */
  aiDefaultModel: string
  /** Quick AI's model — empty string follows `aiDefaultModel`. */
  aiQuickModel: string
  /** Personalization profile text, shared with every chat. */
  aiProfile: string
  /** Directories scanned (top level only) for SKILL.md files. */
  aiSkillDirs: string[]
  /** User-defined `cli:custom:<name>` presets. */
  aiCustomClis: { name: string; command: string[] }[]
  /** How long after the palette is hidden its query/view/selection reset
   *  back to root search on next show. */
  popToRootDelay: 'never' | 'immediately' | '10' | '30' | '60' | '90' | '180'
  /** How aggressively root search filters out weak fuzzy matches. */
  searchSensitivity: 'low' | 'medium' | 'high'
  /** Palette text scale. */
  textSize: 'default' | 'large' | 'larger'
  /** Whether the tray icon is shown at all. */
  showTrayIcon: boolean
  /** Which screen the palette opens centered on. */
  showOnScreen: 'cursor' | 'primary'
  /** Clipboard history row cap, 100–10000 (clamped backend-side). */
  clipboardMaxEntries: number
  /** Clipboard history per-image size cap in MB, 4–256 (clamped backend-side). */
  clipboardMaxImageMb: number
  /** How long a clipboard entry is kept before it's pruned, alongside (not
   *  instead of) `clipboardMaxEntries` — whichever limit is more
   *  restrictive prunes further. `"never"` or a day-count string. */
  clipboardRetentionDays: 'never' | '1' | '7' | '30' | '90' | '180' | '365'
  /** Folders scanned for File Search results. `~/` is expanded backend-side.
   *  Empty means the feature contributes no root-search row at all. */
  fileSearchScopes: string[]
  /** How long a screenshot file is kept before the background sweep moves
   *  it to the OS trash (never permanently deleted). `"unlimited"`
   *  (default) or a day-count string. Pinned screenshots are exempt. */
  screenshotStorageDuration: 'unlimited' | '1' | '7' | '30' | '90' | '180' | '365'
  /** Whether snippet auto-expansion runs — typing a snippet's keyword in
   *  any app replaces it in place with the expanded body. Off by default;
   *  needs OS input permissions and is unavailable on Wayland. */
  snippetAutoExpand: boolean
  /** How a keyword triggers an auto-expansion — `"instant"` (expand once
   *  the keyword is fully typed) or `"delimiter"` (expand once the keyword
   *  is followed by a space, tab, or enter, which is consumed). */
  snippetAutoExpandMode: 'instant' | 'delimiter'
}

export function getSettings(): Promise<Settings> {
  return invoke('get_settings')
}

export function updateSettings(settings: Settings): Promise<void> {
  return invoke('update_settings', { settings })
}

export function updateHotkey(hotkey: string): Promise<void> {
  return invoke('update_hotkey', { hotkey })
}

export function openSettings(): Promise<void> {
  return invoke('open_settings')
}

/** Opens Settings on one extension's own page — what the footer menu of a
 *  running extension command offers. */
export function openExtensionSettings(extensionId: string): Promise<void> {
  return invoke('open_extension_settings', { extensionId })
}

/** The OS-resolved scheme ("light" or "dark"), for settings.theme === 'system'. */
export function getSystemTheme(): Promise<'light' | 'dark'> {
  return invoke('get_system_theme')
}

/** T22: clears only the translate extension's `history:*`-prefixed
 *  storage keys, leaving its custom pairs untouched — see
 *  `api::settings::clear_translate_history`'s doc comment for why this
 *  lives here rather than in the (deleted) native translate module. */
export function clearTranslateHistory(): Promise<void> {
  return invoke('clear_translate_history')
}
