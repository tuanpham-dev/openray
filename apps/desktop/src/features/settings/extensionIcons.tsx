import { convertFileSrc } from '@tauri-apps/api/core'
import { useThemeIcon } from '../../ipc/icons'

/* Names to try in the desktop's icon theme, most specific first. Themes
   aren't required to carry every standard name, so each is a chain. */
export const THEME_ICONS = {
  builtins: ['applications-utilities', 'preferences-desktop', 'applications-system', 'preferences-system'],
  extension: ['preferences-plugin', 'application-x-addon', 'extension'],
} as const

/** An icon-theme glyph, falling back to `children` when the theme has none. */
export function ThemeIcon({ names, children }: { names: readonly string[]; children: React.ReactNode }) {
  const path = useThemeIcon([...names])
  if (!path) return <>{children}</>
  return <img className="openray-settings-row-icon-image" src={convertFileSrc(path)} alt="" />
}
