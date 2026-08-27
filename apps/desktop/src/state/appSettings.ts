import { useSyncExternalStore } from 'react'
import { listen } from '@tauri-apps/api/event'
import { getSettings, type Settings } from '../ipc/settings'

/**
 * The current settings, shared by every consumer in a window.
 *
 * A store rather than a hook-local fetch because settings are read from
 * several places (theme/appearance, list navigation), and each one doing
 * its own `getSettings()` + `settings-changed` subscription would mean N
 * IPC round trips and N listeners for a single value. Mirrors the
 * `useSyncExternalStore` pattern in extensions/registry.ts.
 */
const DEFAULTS: Settings = {
  hotkey: '',
  theme: 'system',
  launchAtLogin: false,
  windowSize: 'medium',
  opacity: 0.85,
  shadow: true,
  altJkNavigation: true,
  scriptDirectories: [],
  windowGap: 0,
  halfCycling: true,
  screenshotSearchScopes: [],
  screenshotVideoExtensions: [],
  screenshotGridColumns: 4,
  screenshotOcrEnabled: true,
  screenshotPasteFormat: 'auto',
  translateTargetLanguage: 'en',
  translateSourceLanguage: 'auto',
  translatePrimaryAction: 'copy',
  translateHistoryEnabled: true,
  notesAlwaysOnTop: false,
  aiDefaultModel: 'anthropic:claude-sonnet-5',
  aiQuickModel: '',
  aiProfile: '',
  aiSkillDirs: ['~/.claude/skills', '~/.config/openray/skills'],
  aiCustomClis: [],
  popToRootDelay: 'never',
  searchSensitivity: 'low',
  textSize: 'default',
  showTrayIcon: true,
  showOnScreen: 'cursor',
  clipboardMaxEntries: 1000,
  clipboardMaxImageMb: 64,
  clipboardRetentionDays: 'never',
  fileSearchScopes: [],
  screenshotStorageDuration: 'unlimited',
}

class AppSettingsStore {
  private state: Settings = DEFAULTS
  private listeners = new Set<() => void>()
  private started = false

  getState = (): Settings => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    this.start()
    return () => this.listeners.delete(listener)
  }

  private set(next: Settings): void {
    this.state = next
    for (const listener of this.listeners) listener()
  }

  /** Idempotent: the first subscriber loads settings and opens the one
   *  `settings-changed` listener, which then lives for the window's life. */
  private start(): void {
    if (this.started) return
    this.started = true

    void getSettings().then((settings) => this.set(settings))
    void listen<Settings>('settings-changed', (event) => this.set(event.payload))
  }
}

const appSettingsStore = new AppSettingsStore()

export function useAppSettings(): Settings {
  return useSyncExternalStore(appSettingsStore.subscribe, appSettingsStore.getState)
}
