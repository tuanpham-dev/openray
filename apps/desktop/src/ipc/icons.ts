import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

/**
 * First of `names` the desktop's icon theme provides, or `null` when the
 * theme carries none of them (and always on macOS/Windows, which have no
 * freedesktop icon theme).
 */
function resolveThemeIcon(names: string[]): Promise<string | null> {
  return invoke('resolve_theme_icon', { names })
}

/**
 * Resolves a themed icon once per name list and caches it for the window's
 * lifetime — the lookup walks the icon theme's directories on disk, and
 * these are static UI glyphs, so re-resolving them on every render (or per
 * row) would be pure filesystem churn.
 */
const cache = new Map<string, string | null>()
const inFlight = new Map<string, Promise<string | null>>()

export function useThemeIcon(names: string[]): string | null {
  const key = names.join('|')
  const [path, setPath] = useState<string | null>(() => cache.get(key) ?? null)

  useEffect(() => {
    if (cache.has(key)) {
      setPath(cache.get(key) ?? null)
      return
    }

    let cancelled = false
    let request = inFlight.get(key)
    if (!request) {
      request = resolveThemeIcon(names).then((resolved) => {
        cache.set(key, resolved)
        inFlight.delete(key)
        return resolved
      })
      inFlight.set(key, request)
    }

    void request.then((resolved) => {
      if (!cancelled) setPath(resolved)
    })

    return () => {
      cancelled = true
    }
    // `names` is recreated per render by callers passing an array literal;
    // the joined key is the stable identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return path
}
