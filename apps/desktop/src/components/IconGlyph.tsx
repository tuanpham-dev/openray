import type { ReactNode } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { SYSTEM_ICON_NAMES } from './systemIconNames'

/** Unix `/…` or Windows `C:\…` — an icon that is a file on disk rather
 *  than an emoji/glyph. */
function isAbsolutePath(icon: string): boolean {
  return icon.startsWith('/') || /^[A-Za-z]:[\\/]/.test(icon)
}

interface IconGlyphProps {
  icon?: string | null
  size?: number
  svgClassName?: string
  imageClassName?: string
  textClassName?: string
  /** Rendered when there's no icon at all — every call site's own
   *  last-resort (a letter avatar in the palette, a puzzle piece in
   *  Settings). */
  fallback?: ReactNode
}

/** The app's one icon-string convention, shared by the palette and
 *  Settings: a `SYSTEM_ICON_NAMES` key (first-party monoline SVG), an
 *  absolute file path (`<img>`), or a literal glyph (emoji/text) —
 *  rendered in that order, falling through to `fallback` when `icon` is
 *  empty or doesn't match any of those. */
export function IconGlyph({ icon, size = 18, svgClassName, imageClassName, textClassName, fallback = null }: IconGlyphProps) {
  const SystemIcon = icon ? SYSTEM_ICON_NAMES[icon] : undefined
  if (SystemIcon) {
    return <SystemIcon size={size} className={svgClassName} />
  }

  if (icon && isAbsolutePath(icon)) {
    // Sized by `imageClassName`'s own CSS (each call site's image class
    // already fixes a pixel size), not `size` — matches this codebase's
    // pre-existing convention for icon `<img>`s.
    return <img className={imageClassName} src={convertFileSrc(icon)} alt="" />
  }

  if (icon) {
    return <span className={textClassName}>{icon}</span>
  }

  return <>{fallback}</>
}
