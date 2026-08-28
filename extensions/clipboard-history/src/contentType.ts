/**
 * Classifies a clipboard entry so the UI can show a fitting preview and
 * offer type-appropriate actions.
 *
 * Detection is deliberately conservative and anchored to the whole value:
 * a wrong guess changes which actions a user is offered, so it's better to
 * fall back to plain text than to half-match something that merely
 * contains a URL or a hex-looking word.
 */

export type ClipboardContentKind = 'color' | 'url' | 'email' | 'number' | 'text'

export interface Rgb {
  r: number
  g: number
  b: number
  /** 0–1; 1 when the source carried no alpha. */
  a: number
}

const HEX_PATTERN = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const RGB_PATTERN = /^rgba?\(\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/i
const HSL_PATTERN = /^hsla?\(\s*[\d.]+(?:deg)?\s*[,\s]\s*[\d.]+%\s*[,\s]\s*[\d.]+%\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/i
const URL_PATTERN = /^https?:\/\/[^\s]+$/i
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+\.[^\s@]+$/
const NUMBER_PATTERN = /^-?\d+(?:\.\d+)?$/

function expandShortHex(hex: string): string {
  // #rgb / #rgba → #rrggbb / #rrggbbaa
  return hex
    .split('')
    .map((char) => char + char)
    .join('')
}

/** Parses a hex or rgb() colour into channels. `hsl()` is recognised as a
 *  colour elsewhere but not parsed here — converting it correctly needs a
 *  full colour-space conversion, and a half-right one is worse than none. */
export function parseColor(value: string): Rgb | null {
  const text = value.trim()

  if (HEX_PATTERN.test(text)) {
    let hex = text.slice(1)
    if (hex.length === 3 || hex.length === 4) hex = expandShortHex(hex)
    const r = parseInt(hex.slice(0, 2), 16)
    const g = parseInt(hex.slice(2, 4), 16)
    const b = parseInt(hex.slice(4, 6), 16)
    const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1
    return { r, g, b, a }
  }

  const rgb = RGB_PATTERN.exec(text)
  if (rgb) {
    const [r, g, b] = [rgb[1], rgb[2], rgb[3]].map(Number)
    if (r > 255 || g > 255 || b > 255) return null
    const rawAlpha = rgb[4]
    const a = rawAlpha === undefined ? 1 : rawAlpha.endsWith('%') ? Number(rawAlpha.slice(0, -1)) / 100 : Number(rawAlpha)
    return { r, g, b, a: Number.isFinite(a) ? Math.min(Math.max(a, 0), 1) : 1 }
  }

  return null
}

export function toHex({ r, g, b, a }: Rgb): string {
  const pair = (channel: number) => channel.toString(16).padStart(2, '0')
  const alpha = a < 1 ? pair(Math.round(a * 255)) : ''
  return `#${pair(r)}${pair(g)}${pair(b)}${alpha}`.toUpperCase()
}

export function toRgbString({ r, g, b, a }: Rgb): string {
  return a < 1 ? `rgba(${r}, ${g}, ${b}, ${Number(a.toFixed(3))})` : `rgb(${r}, ${g}, ${b})`
}

/** A CSS colour string safe to render as a swatch. */
export function toCssColor(rgb: Rgb): string {
  return toRgbString(rgb)
}

export function detectContentKind(text: string): ClipboardContentKind {
  const value = text.trim()
  if (value === '' || value.includes('\n')) return 'text'

  if (HEX_PATTERN.test(value) || RGB_PATTERN.test(value) || HSL_PATTERN.test(value)) return 'color'
  if (URL_PATTERN.test(value)) return 'url'
  if (EMAIL_PATTERN.test(value)) return 'email'
  if (NUMBER_PATTERN.test(value)) return 'number'
  return 'text'
}

/** Host shown alongside a URL preview; `null` when it won't parse. */
export function urlHost(value: string): string | null {
  try {
    return new URL(value.trim()).host
  } catch {
    return null
  }
}
