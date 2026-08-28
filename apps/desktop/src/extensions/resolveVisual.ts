export type VisualMask = 'circle' | 'roundedRectangle'

export interface VisualSource {
  source: string
  tint?: string
  /** Shapes the rendered image — see `Image.Mask`. */
  mask?: VisualMask
}

/**
 * Flattens every shape Raycast's `Image.ImageLike` allows into one string
 * plus an optional tint.
 *
 * `List.Item.icon`, `Grid.Item.content` and an `Action`'s icon all take
 * this type, and it is a wider union than it looks (`@raycast/api`'s
 * `Image.Source`):
 *
 * - a bare string — an emoji, a hex swatch, a URL, an absolute path, or an
 *   `Icon` name, since the whole `Icon` enum is just strings;
 * - `{ source, tintColor }`;
 * - `{ source: { light, dark } }`, a different asset per theme;
 * - `{ fileIcon: "/some/path" }`, "whatever the OS shows for this file".
 *
 * The theme-aware form used to reach the renderer as an object where a
 * string was expected and threw on `.startsWith` — taking down the whole
 * mounted command, not just its icon.
 *
 * `mask` shapes the result (Raycast uses the circle for avatars); it is
 * carried through here and applied by the renderer's own CSS.
 */
export function resolveVisual(raw: unknown): VisualSource {
  if (typeof raw === 'string') return { source: raw }
  if (!raw || typeof raw !== 'object') return { source: '' }

  const obj = raw as {
    source?: unknown
    tintColor?: string
    mask?: unknown
    fileIcon?: unknown
    fallback?: unknown
  }
  const tint = typeof obj.tintColor === 'string' ? obj.tintColor : undefined
  const mask = obj.mask === 'circle' || obj.mask === 'roundedRectangle' ? obj.mask : undefined

  // `{ fileIcon }` names a file whose *system* icon is wanted. We have no
  // way to ask the OS for one from here, so the path is passed through:
  // an image file renders itself, and anything else falls through to the
  // caller's own empty handling rather than erroring.
  if (typeof obj.fileIcon === 'string') return { source: obj.fileIcon, tint, mask }

  const source = resolveSource(obj.source)
  if (source) return { source, tint, mask }

  // `fallback` takes the same shapes as `source`, minus the remote URL,
  // and Raycast applies the same mask and tint to it.
  const fallback = resolveSource(obj.fallback)
  return fallback ? { source: fallback, tint, mask } : { source: '', tint, mask }
}

function resolveSource(source: unknown): string {
  if (typeof source === 'string') return source
  if (!source || typeof source !== 'object') return ''
  const themed = source as { light?: unknown; dark?: unknown }
  const preferred = currentTheme() === 'dark' ? themed.dark : themed.light
  if (typeof preferred === 'string') return preferred
  // A half-specified pair still beats showing nothing.
  const other = currentTheme() === 'dark' ? themed.light : themed.dark
  return typeof other === 'string' ? other : ''
}

/** `ThemeProvider` resolves "system" against Tauri's native theme API and
 *  stamps the answer here, so this is the one place that already knows
 *  which of a `{ light, dark }` pair applies. */
function currentTheme(): 'light' | 'dark' {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}
