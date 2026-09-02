// Originally ported from src-tauri/src/application/system_commands.rs's
// `table()`, Linux-only (the native module compiled only its
// `#[cfg(target_os = "linux")]` branch here too). macOS support (below)
// was added later: unlike Linux's `linuxRequires`, which probes PATH for
// optional tools that may or may not be installed, macOS's equivalents
// (`osascript`, `pmset`, `open`) ship on every real Mac, so availability
// there is just a static "does a real thing exist to run" flag —
// `macosSupported: false` for the two rows (Bluetooth, Show Desktop) that
// would need something this extension deliberately doesn't reach for:
// Bluetooth toggling needs root (`blueutil`-style tools rewrite a system
// daemon's power state and restart it) and Show Desktop needs
// Accessibility permission for a keystroke whose binding assumes the
// user never remapped Mission Control's shortcut — both a step up from
// every other row here, which needs no extra permission or privilege at
// all. Hidden the same way Linux hides a row whose binary is missing,
// rather than offered and then failing or popping an unexpected prompt.

export interface SystemCommandMeta {
  id: string
  title: string
  /** Kebab-case name resolved by the frontend's `SYSTEM_ICON_NAMES` map. */
  icon: string
  keywords: string[]
  /** Binaries this command's action needs; missing any hides the row. */
  linuxRequires: string[]
  /** `false` hides the row entirely on macOS — no built-in way to do it
   *  without a private API or a third-party tool. Every other row has a
   *  real `osascript`/`pmset`/`open` action in `actions.ts`. */
  macosSupported?: false
}

export const TABLE: SystemCommandMeta[] = [
  { id: 'lock-screen', title: 'Lock Screen', icon: 'lock', keywords: ['lock'], linuxRequires: ['loginctl'] },
  { id: 'sleep', title: 'Sleep', icon: 'moon', keywords: ['suspend'], linuxRequires: ['systemctl'] },
  { id: 'restart', title: 'Restart', icon: 'refresh', keywords: ['reboot'], linuxRequires: ['systemctl'] },
  { id: 'shut-down', title: 'Shut Down', icon: 'power', keywords: ['power off', 'poweroff'], linuxRequires: ['systemctl'] },
  { id: 'log-out', title: 'Log Out', icon: 'log-out', keywords: ['sign out', 'logout'], linuxRequires: [] },
  { id: 'sleep-displays', title: 'Sleep Displays', icon: 'monitor-off', keywords: ['screen off', 'displays off'], linuxRequires: ['xset'] },
  { id: 'screen-saver', title: 'Show Screen Saver', icon: 'sparkles', keywords: ['screensaver'], linuxRequires: ['xdg-screensaver'] },
  { id: 'play-pause', title: 'Play / Pause', icon: 'play-pause', keywords: ['music', 'media'], linuxRequires: ['playerctl'] },
  { id: 'next-track', title: 'Next Track', icon: 'skip-forward', keywords: ['music', 'media', 'skip'], linuxRequires: ['playerctl'] },
  { id: 'previous-track', title: 'Previous Track', icon: 'skip-back', keywords: ['music', 'media'], linuxRequires: ['playerctl'] },
  { id: 'toggle-mute', title: 'Toggle Mute', icon: 'volume-x', keywords: ['volume', 'audio', 'sound'], linuxRequires: [] },
  { id: 'volume-up', title: 'Turn Volume Up', icon: 'volume-2', keywords: ['audio', 'sound', 'louder'], linuxRequires: [] },
  { id: 'volume-down', title: 'Turn Volume Down', icon: 'volume-1', keywords: ['audio', 'sound', 'quieter'], linuxRequires: [] },
  { id: 'volume-0', title: 'Set Volume to 0%', icon: 'volume-x', keywords: ['mute', 'audio'], linuxRequires: [] },
  { id: 'volume-25', title: 'Set Volume to 25%', icon: 'volume', keywords: ['audio'], linuxRequires: [] },
  { id: 'volume-50', title: 'Set Volume to 50%', icon: 'volume-1', keywords: ['audio'], linuxRequires: [] },
  { id: 'volume-75', title: 'Set Volume to 75%', icon: 'volume-2', keywords: ['audio'], linuxRequires: [] },
  { id: 'volume-100', title: 'Set Volume to 100%', icon: 'volume-2', keywords: ['audio'], linuxRequires: [] },
  { id: 'open-trash', title: 'Open Trash', icon: 'trash', keywords: ['recycle bin'], linuxRequires: ['gio'] },
  { id: 'empty-trash', title: 'Empty Trash', icon: 'trash', keywords: ['recycle bin', 'delete'], linuxRequires: ['gio'] },
  { id: 'show-desktop', title: 'Show Desktop', icon: 'monitor', keywords: ['minimize all', 'hide windows'], linuxRequires: ['wmctrl'], macosSupported: false },
  { id: 'toggle-bluetooth', title: 'Toggle Bluetooth', icon: 'bluetooth', keywords: ['wireless'], linuxRequires: ['rfkill'], macosSupported: false },
  { id: 'toggle-appearance', title: 'Toggle System Appearance', icon: 'system-theme', keywords: ['dark mode', 'light mode', 'theme'], linuxRequires: ['gsettings'] },
]

/** Mirrors native `CONFIRM_COMMAND_IDS` (`system_commands.rs`). */
export const CONFIRM_IDS = new Set(['shut-down', 'restart', 'log-out', 'empty-trash'])
