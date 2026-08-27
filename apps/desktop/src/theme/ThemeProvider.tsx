import { createContext, useEffect, useState, type ReactNode } from 'react'
import { listen } from '@tauri-apps/api/event'
import { getSystemTheme } from '../ipc/settings'
import { useAppSettings } from '../state/appSettings'

export type ThemePreference = 'system' | 'light' | 'dark'
type ResolvedTheme = 'light' | 'dark'

interface ThemeContextValue {
  theme: ThemePreference
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

// `settings.theme === 'system'` resolves to this rather than to CSS's own
// `prefers-color-scheme` media query — WebKitGTK on Linux doesn't reliably
// keep that media query in sync with the desktop's actual dark-mode
// setting, so the OS-resolved value comes from Tauri's native theme API
// (get_system_theme / the ThemeChanged window event) instead.
function applyTheme(theme: ThemePreference, systemTheme: ResolvedTheme) {
  document.documentElement.dataset.theme = theme === 'system' ? systemTheme : theme
}

/**
 * Palette translucency and drop shadow, applied as inline custom
 * properties on :root so they override the theme stylesheet's defaults.
 * Shadow-off sets `none`; shadow-on *removes* the override rather than
 * writing a value, so the per-theme shadow from tokens.css takes over
 * again (light and dark use different ones).
 */
function applyAppearance(opacity: number, shadow: boolean) {
  const root = document.documentElement
  root.style.setProperty('--openray-palette-opacity', String(opacity))
  if (shadow) {
    root.style.removeProperty('--openray-shadow')
  } else {
    root.style.setProperty('--openray-shadow', 'none')
  }
}

const FONT_SCALE_BY_TEXT_SIZE: Record<string, number> = {
  default: 1.0,
  large: 1.08,
  larger: 1.16,
}

/** Every scaled `font-size`/geometry declaration in palette.css (and the
 *  Notes editor's markdown-editor.css) reads this var via
 *  `calc(Npx * var(--openray-font-scale, 1))` — see
 *  `plans/raycast-settings-parity.md`'s Phase 3 (T7) for which
 *  declarations were converted and why the rest (icon glyph boxes,
 *  borders, the shadow margin) were deliberately left alone. */
function applyFontScale(textSize: string) {
  document.documentElement.style.setProperty('--openray-font-scale', String(FONT_SCALE_BY_TEXT_SIZE[textSize] ?? 1.0))
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const { theme, opacity, shadow, textSize } = useAppSettings()
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>('light')

  useEffect(() => {
    let cancelled = false

    void getSystemTheme().then((resolved) => {
      if (!cancelled) setSystemTheme(resolved)
    })

    const unlistenSystemTheme = listen<ResolvedTheme>('system-theme-changed', (event) => {
      setSystemTheme(event.payload)
    })

    return () => {
      cancelled = true
      void unlistenSystemTheme.then((unlisten) => unlisten())
    }
  }, [])

  useEffect(() => {
    applyTheme(theme, systemTheme)
  }, [theme, systemTheme])

  useEffect(() => {
    applyAppearance(opacity, shadow)
  }, [opacity, shadow])

  useEffect(() => {
    applyFontScale(textSize)
  }, [textSize])

  return <ThemeContext.Provider value={{ theme }}>{children}</ThemeContext.Provider>
}
