// Reads the desktop app's own icon set so anything the site draws uses the
// exact glyph the palette draws. Shared by the screenshot renderer and the
// landing page, and re-read on every build, so it cannot drift from the app.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/* Resolved by walking up from the working directory rather than from this
   module's own URL: Astro bundles this file into dist/ when the landing page
   imports it, which would make a module-relative path point at the wrong
   tree. Works whether a command runs from the repo root or apps/website. */
function findAppComponents() {
  let dir = process.cwd()
  for (let up = 0; up < 6; up++) {
    const candidate = join(dir, 'apps', 'desktop', 'src', 'components')
    if (existsSync(join(candidate, 'icons.tsx'))) return candidate
    dir = dirname(dir)
  }
  throw new Error('Could not locate apps/desktop/src/components from ' + process.cwd())
}

const APP_SRC = findAppComponents()

function loadAppIcons() {
  const icons = readFileSync(join(APP_SRC, 'icons.tsx'), 'utf8')
  const names = readFileSync(join(APP_SRC, 'systemIconNames.tsx'), 'utf8')

  const frame = /const WINDOW_FRAME = \{([^}]*)\}/.exec(icons)
  const attrs = (text) =>
    [...text.matchAll(/(\w+):\s*'?([\w.-]+)'?/g)].map((m) => `${m[1]}="${m[2]}"`).join(' ')

  const bodies = new Map()
  for (const m of icons.matchAll(/function ([A-Za-z0-9]+Icon)\([^)]*\)\s*\{\s*return\s*([\s\S]*?)\n\}/g)) {
    bodies.set(m[1], m[2])
  }

  const resolve = (component, depth = 0) => {
    if (depth > 3 || !bodies.has(component)) return null
    const body = bodies.get(component)
    const win = /<WindowFrameIcon[^>]*inner=\{\{([^}]*)\}\}/.exec(body)
    if (win) {
      return `<rect ${attrs(frame[1])} fill="none"/>` +
             `<rect ${attrs(win[1])} rx="1" fill="currentColor" stroke="none"/>`
    }
    const svg = /<Svg[^>]*>([\s\S]*?)<\/Svg>/.exec(body)
    if (svg) {
      // Some icons draw the shared window outline via a JSX spread; expand it
      // so the output is real SVG rather than `{...WINDOW_FRAME}`.
      return svg[1]
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')          // JSX comments
        .replace(/\{\.\.\.WINDOW_FRAME\}/g, attrs(frame[1]))
        .replace(/\s+/g, ' ')
        .trim()
    }
    const alias = /<([A-Za-z0-9]+Icon) \{\.\.\.props\}/.exec(body)
    return alias ? resolve(alias[1], depth + 1) : null
  }

  const table = {}
  const start = names.indexOf('SYSTEM_ICON_NAMES')
  for (const m of names.slice(start).matchAll(/^\s+'?([a-z0-9-]+)'?:\s*([A-Za-z0-9]+Icon)/gm)) {
    const drawn = resolve(m[2])
    if (!drawn) continue
    // A leftover brace means a JSX construct this reader doesn't understand;
    // shipping it would emit SVG no browser can parse.
    if (drawn.includes('{')) throw new Error(`Icon "${m[1]}" did not fully resolve: ${drawn.slice(0, 80)}`)
    table[m[1]] = drawn
  }
  const declared = [...names.slice(start).matchAll(/^\s+'?([a-z0-9-]+)'?:\s*[A-Za-z0-9]+Icon/gm)].map((m) => m[1])
  const missed = declared.filter((n) => !table[n])
  if (missed.length) throw new Error(`Could not read these app icons: ${missed.join(', ')}`)
  return table
}


export const APP_ICONS = loadAppIcons()

/** One icon as a standalone <svg>, sized and coloured by the caller. */
export function iconSvg(name, { size = 20, color = 'currentColor', strokeWidth = 1.5 } = {}) {
  const d = APP_ICONS[name]
  if (!d) throw new Error(`Unknown app icon: ${name}`)
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" ` +
    `stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`
}
