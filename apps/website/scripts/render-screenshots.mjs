#!/usr/bin/env node
/**
 * Renders the documentation's screenshots as plain SVG.
 *
 * These are drawings of the palette, not captures of it: this repo's dev
 * sandbox can't render the app's transparent window headlessly, and a real
 * capture would bake in one machine's wallpaper, fonts and DPI anyway. Every
 * colour below is copied from the app's own dark theme
 * (apps/desktop/src/theme/tokens.css), so the drawings stay honest about what
 * the product looks like.
 *
 * Output is committed to public/screenshots/ because README.md embeds the same
 * files by relative path, where no build step runs.
 *
 * Only shapes and <text> are emitted — no <foreignObject>, no CSS, no scripts —
 * so GitHub's SVG sanitiser passes them through intact.
 *
 *   node scripts/render-screenshots.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APP_ICONS } from './app-icons.mjs'

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'screenshots')

/** Dark-theme values from apps/desktop/src/theme/tokens.css. */
const P = {
  bg: '#1b1b1b',
  raised: '#222222',
  border: '#303030',
  text: '#f2f2f2',
  text2: '#a5a5a5',
  text3: '#7d7d7d',
  selected: '#323232',
  hover: '#272727',
  accent: '#007aff',
  danger: '#f84e4e',
  footer: '#222222',
  kbdBg: '#323232',
  kbdBorder: '#3d3d3d',
}

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Inter, 'Helvetica Neue', Arial, sans-serif"
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace"

// Window geometry. WIDTH matches the app's default palette width; the canvas
// adds MARGIN on every side so the drop shadow has room.
const WIDTH = 760
const MARGIN = 28
// Every number below is read off apps/desktop/src/components/palette.css.
const RADIUS = 10          // .palette
const SEARCH_H = 60        // .openray-search-bar height
const FOOTER_H = 40        // .openray-footer height
const PAD = 8              // .openray-result-list padding
const ROW_H = 48           // .openray-list-item height
const ROW_RADIUS = 6       // .openray-list-item border-radius
const ROW_GAP = 12         // .openray-list-item gap
const ROW_PAD = 8          // .openray-list-item padding-inline
const ICON_SLOT = 22       // .openray-list-item-icon box
const ICON_DRAW = 18       // IconGlyph size= in ListItem
const SECTION_H = 28       // .openray-result-section-label 6/8/4 + 13px line

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Rough advance width; good enough to decide where to clip a label. */
const widthOf = (s, size, weight = 400) => String(s).length * size * (weight >= 600 ? 0.58 : 0.545)

const clip = (s, size, max, weight = 400) => {
  let out = String(s)
  if (widthOf(out, size, weight) <= max) return out
  while (out.length > 1 && widthOf(out + '…', size, weight) > max) out = out.slice(0, -1)
  return out.trimEnd() + '…'
}

const text = (x, y, s, { size = 14, fill = P.text, weight = 400, anchor = 'start', mono = false } = {}) =>
  `<text x="${x}" y="${y}" font-family="${mono ? MONO : FONT}" font-size="${size}" font-weight="${weight}" fill="${fill}"${anchor === 'start' ? '' : ` text-anchor="${anchor}"`}>${esc(s)}</text>`

const rect = (x, y, w, h, { fill = 'none', r = 0, stroke = null, strokeWidth = 1, opacity = null } = {}) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}"${r ? ` rx="${r}" ry="${r}"` : ''} fill="${fill}"${stroke ? ` stroke="${stroke}" stroke-width="${strokeWidth}"` : ''}${opacity !== null ? ` opacity="${opacity}"` : ''}/>`

const line = (x1, y1, x2, y2, stroke = P.border) =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="1"/>`

/**
 * The app's own icon set, read straight out of
 * apps/desktop/src/components/icons.tsx at render time, so a screenshot can
 * never drift from the glyph the palette actually draws. Icons are Feather
 * geometry on a 24x24 viewBox, 1.5 stroke, no fill, painted in the row's
 * secondary text colour — see `IconGlyph`/`ListItem`.
 */

/** A named icon from the app's set, drawn the way the palette draws it. */
const sysIcon = (x, y, name, { size = ICON_DRAW, color = P.text2 } = {}) => {
  const d = APP_ICONS[name]
  if (!d) throw new Error(`Unknown app icon: ${name}`)
  const scale = size / 24
  return `<g transform="translate(${x} ${y}) scale(${scale.toFixed(4)})" fill="none" ` +
    `stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${d}</g>`
}

/** An installed application's own artwork — the palette shows a real image
 *  here, so these stay coloured tiles rather than monoline glyphs. */
const appIcon = (x, y, size, { bg = '#3a3a3c', fg = '#ffffff', glyph = '?' } = {}) => {
  const fs = Math.round(size * (glyph.length > 1 ? 0.44 : 0.56))
  return rect(x, y, size, size, { fill: bg, r: 5 }) +
    text(x + size / 2, y + size / 2 + fs * 0.36, glyph, { size: fs, fill: fg, weight: 600, anchor: 'middle' })
}

/** The letter avatar the palette falls back to when an icon name resolves
 *  to nothing (`ListItem`'s `fallback`). */
const letterIcon = (x, y, size, ch) =>
  rect(x, y, size, size, { fill: P.selected, r: 5 }) +
  text(x + size / 2, y + size / 2 + 4, ch.toUpperCase(), { size: 11, fill: P.text2, weight: 600, anchor: 'middle' })

/** Dispatches whichever of the three the scene asked for. */
const drawIcon = (x, y, slot, spec) => {
  if (typeof spec === 'string') {
    const inset = (slot - ICON_DRAW) / 2
    return sysIcon(x + inset, y + inset, spec)
  }
  if (spec && spec.letter) return letterIcon(x, y, slot, spec.letter)
  return appIcon(x, y, slot, spec ?? {})
}

/** A keyboard cap, as drawn in the palette footer. */
const kbd = (xRight, yCenter, label) => {
  const fs = 11.5
  const w = Math.max(20, Math.ceil(widthOf(label, fs, 600)) + 12)
  const h = 20
  const x = xRight - w
  const y = yCenter - h / 2
  return {
    width: w,
    svg:
      rect(x, y, w, h, { fill: P.kbdBg, r: 5, stroke: P.kbdBorder }) +
      text(x + w / 2, y + h / 2 + fs * 0.35, label, { size: fs, fill: P.text2, weight: 600, anchor: 'middle' }),
  }
}

const searchIcon = (x, y, fill = P.text3) =>
  `<g transform="translate(${x} ${y})" fill="none" stroke="${fill}" stroke-width="1.8" stroke-linecap="round"><circle cx="7.5" cy="7.5" r="5.8"/><line x1="11.8" y1="11.8" x2="16" y2="16"/></g>`

const chevron = (x, y, fill = P.text3) =>
  `<path d="M${x} ${y - 4} l4 4 l-4 4" fill="none" stroke="${fill}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`

const checkMark = (x, y, fill = P.accent) =>
  `<path d="M${x} ${y} l3.4 3.6 l6.6 -8" fill="none" stroke="${fill}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`

// ─────────────────────────────────────────────────────────────────────────────
// Window chrome
// ─────────────────────────────────────────────────────────────────────────────

const defs = () => `
  <defs>
    <filter id="win-shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="14" stdDeviation="18" flood-color="#000000" flood-opacity="0.45"/>
    </filter>
    <linearGradient id="hero-bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#8B45FF"/>
      <stop offset="0.55" stop-color="#6236FF"/>
      <stop offset="1" stop-color="#2F6BFF"/>
    </linearGradient>
    <radialGradient id="hero-glow" cx="0.5" cy="0.32" r="0.72">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.22"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
  </defs>`

const windowFrame = (x, y, w, h) =>
  `<g filter="url(#win-shadow)">${rect(x, y, w, h, { fill: P.bg, r: RADIUS, stroke: P.border })}</g>`

const backArrow = (x, y, fill = P.text2) =>
  `<path d="M${x + 10} ${y + 3} L${x + 5} ${y + 8} L${x + 10} ${y + 13}" fill="none" stroke="${fill}" ` +
  `stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`

const searchBar = (x, y, w, { query = '', placeholder = 'Search for apps and commands…', back = false } = {}) => {
  const out = []
  // .openray-search-bar: padding-inline 18, gap 10, 16px leading glyph.
  let cursorX = x + 18
  if (back) {
    out.push(backArrow(cursorX, y + SEARCH_H / 2 - 8))
  } else {
    out.push(searchIcon(cursorX, y + SEARCH_H / 2 - 8))
  }
  cursorX += 16 + 10
  const shown = query || placeholder
  out.push(
    text(cursorX, y + SEARCH_H / 2 + 6, clip(shown, 17, x + w - 60 - cursorX), {
      size: 17,
      fill: query ? P.text : P.text3,
    }),
  )
  if (query) {
    const caretX = cursorX + widthOf(query, 17) + 2
    out.push(rect(caretX, y + SEARCH_H / 2 - 10, 1.6, 20, { fill: P.accent, opacity: 0.9 }))
  }
  out.push(line(x + 1, y + SEARCH_H, x + w - 1, y + SEARCH_H))
  return out.join('')
}

const footer = (x, y, w, { command = 'OpenRay', icon = { bg: '#6236FF', glyph: '⚡' }, actions = [] } = {}) => {
  const out = []
  const cy = y + FOOTER_H / 2
  out.push(
    `<path d="M${x + 1} ${y} h${w - 2} v${FOOTER_H - RADIUS} a${RADIUS} ${RADIUS} 0 0 1 -${RADIUS} ${RADIUS} h-${w - 2 - RADIUS * 2} a${RADIUS} ${RADIUS} 0 0 1 -${RADIUS} -${RADIUS} z" fill="${P.footer}"/>`,
  )
  out.push(line(x + 1, y, x + w - 1, y))
  out.push(drawIcon(x + 12, cy - 9, 18, icon))
  out.push(text(x + 40, cy + 4.5, command, { size: 13, fill: P.text2, weight: 500 }))

  let right = x + w - 14
  for (let i = actions.length - 1; i >= 0; i--) {
    const { label, keys } = actions[i]
    for (let k = keys.length - 1; k >= 0; k--) {
      const cap = kbd(right, cy, keys[k])
      out.push(cap.svg)
      right -= cap.width + 4
    }
    right -= 4
    out.push(text(right, cy + 4.5, label, { size: 13, fill: P.text2, anchor: 'end' }))
    right -= widthOf(label, 13) + 16
    if (i > 0) {
      out.push(line(right + 4, cy - 9, right + 4, cy + 9, P.border))
      right -= 8
    }
  }
  return out.join('')
}

// ─────────────────────────────────────────────────────────────────────────────
// List body
// ─────────────────────────────────────────────────────────────────────────────

/** Height a section list occupies, so the window can be sized to its content. */
const listHeight = (sections) =>
  PAD * 2 +
  sections.reduce((sum, s) => sum + (s.title ? SECTION_H : 0) + s.rows.length * ROW_H, 0)

const listBody = (x, y, w, sections, selected) => {
  const out = []
  let cy = y + PAD
  let index = 0
  for (const section of sections) {
    if (section.title) {
      out.push(text(x + PAD + ROW_PAD, cy + 18, section.title, { size: 13, fill: P.text2, weight: 400 }))
      cy += SECTION_H
    }
    for (const row of section.rows) {
      const isSelected = index === selected
      if (isSelected) out.push(rect(x + PAD, cy, w - PAD * 2, ROW_H, { fill: P.selected, r: ROW_RADIUS }))

      let tx = x + PAD + ROW_PAD
      if (row.icon !== null) {
        out.push(drawIcon(tx, cy + (ROW_H - ICON_SLOT) / 2, ICON_SLOT, row.icon))
        tx += ICON_SLOT + ROW_GAP
      }

      // Right side first, so the title knows how much room is left.
      let rightEdge = x + w - PAD - ROW_PAD
      if (isSelected && row.hint) {
        const cap = kbd(rightEdge, cy + ROW_H / 2, row.hint)
        out.push(cap.svg)
        rightEdge -= cap.width + 8
      }
      if (row.accessory) {
        out.push(
          text(rightEdge, cy + ROW_H / 2 + 4.5, row.accessory, { size: 13, fill: P.text2, anchor: 'end' }),
        )
        rightEdge -= widthOf(row.accessory, 13) + 14
      }
      if (row.tag) {
        const tw = Math.ceil(widthOf(row.tag, 11, 600)) + 14
        out.push(
          rect(rightEdge - tw, cy + ROW_H / 2 - 9, tw, 18, {
            fill: 'none',
            r: 5,
            stroke: row.tagColor ?? P.border,
          }),
        )
        out.push(
          text(rightEdge - tw / 2, cy + ROW_H / 2 + 4, row.tag, {
            size: 11,
            fill: row.tagColor ?? P.text3,
            weight: 600,
            anchor: 'middle',
          }),
        )
        rightEdge -= tw + 12
      }

      const available = rightEdge - tx
      const title = clip(row.title, 14, row.subtitle ? available * 0.62 : available, 500)
      out.push(text(tx, cy + ROW_H / 2 + 4.5, title, { size: 14, fill: P.text, weight: 450 }))
      if (row.subtitle) {
        const sx = tx + widthOf(title, 14, 500) + 10
        out.push(
          text(sx, cy + ROW_H / 2 + 4.5, clip(row.subtitle, 13, rightEdge - sx), {
            size: 13,
            fill: P.text2,
          }),
        )
      }
      cy += ROW_H
      index += 1
    }
  }
  return out.join('')
}

// ─────────────────────────────────────────────────────────────────────────────
// Scene kinds
// ─────────────────────────────────────────────────────────────────────────────

const svgDoc = (w, h, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img">${defs()}\n${body}\n</svg>\n`

/** A plain palette window: search bar, list, footer. */
function renderPalette(scene) {
  const w = scene.width ?? WIDTH
  const inner = []
  const inlineH = scene.inline ? (scene.inline.height ?? 92) : 0
  const bodyH = scene.bodyHeight ?? listHeight(scene.sections ?? []) + inlineH
  const h = SEARCH_H + bodyH + FOOTER_H
  const x = MARGIN
  const y = MARGIN

  inner.push(windowFrame(x, y, w, h))
  inner.push(searchBar(x, y, w, scene))

  let contentY = y + SEARCH_H
  if (scene.inline) {
    inner.push(renderInlineCard(x, contentY, w, scene.inline))
    contentY += inlineH
  }
  if (scene.sections) inner.push(listBody(x, contentY, w, scene.sections, scene.selected ?? 0))
  if (scene.empty) {
    const remaining = y + SEARCH_H + bodyH - contentY
    inner.push(
      text(x + w / 2, contentY + remaining / 2 + 5, scene.empty, {
        size: 14,
        fill: P.text3,
        anchor: 'middle',
      }),
    )
  }
  inner.push(footer(x, y + h - FOOTER_H, w, scene.footer ?? {}))
  return svgDoc(w + MARGIN * 2, h + MARGIN * 2, inner.join('\n'))
}

/** The inline result card the calculator and translate rows draw. */
function renderInlineCard(x, y, w, card) {
  const h = card.height ?? 92
  const out = []
  out.push(rect(x + PAD, y + PAD, w - PAD * 2, h - PAD * 2, { fill: P.raised, r: 10, stroke: P.border }))
  out.push(text(x + 28, y + 34, card.label, { size: 12, fill: P.text3, weight: 600 }))
  out.push(
    text(x + 28, y + 66, clip(card.value, 24, w - 200), { size: 24, fill: P.text, weight: 600 }),
  )
  if (card.hint) {
    out.push(text(x + w - 28, y + 66, card.hint, { size: 13, fill: P.text3, anchor: 'end' }))
  }
  return out.join('')
}

/** A list with a detail pane beside it (List + Detail commands). */
function renderDetail(scene) {
  const w = scene.width ?? 900
  const listW = Math.round(w * 0.42)
  const bodyH = scene.bodyHeight ?? Math.max(listHeight(scene.sections), 300)
  const h = SEARCH_H + bodyH + FOOTER_H
  const x = MARGIN
  const y = MARGIN
  const inner = []

  inner.push(windowFrame(x, y, w, h))
  inner.push(searchBar(x, y, w, scene))
  inner.push(listBody(x, y + SEARCH_H, listW, scene.sections, scene.selected ?? 0))
  inner.push(line(x + listW, y + SEARCH_H + 1, x + listW, y + SEARCH_H + bodyH - 1))

  const dx = x + listW + 22
  const dw = w - listW - 44
  let dy = y + SEARCH_H + 30
  for (const item of scene.detail ?? []) {
    if (item.kind === 'heading') {
      inner.push(text(dx, dy, item.text, { size: 16, fill: P.text, weight: 600 }))
      dy += 26
    } else if (item.kind === 'para') {
      for (const ln of wrap(item.text, 13, dw)) {
        inner.push(text(dx, dy, ln, { size: 13, fill: P.text2 }))
        dy += 20
      }
      dy += 8
    } else if (item.kind === 'code') {
      const boxH = item.lines.length * 19 + 18
      inner.push(rect(dx, dy - 14, dw, boxH, { fill: P.raised, r: 8, stroke: P.border }))
      let ly = dy + 4
      for (const ln of item.lines) {
        inner.push(text(dx + 12, ly, clip(ln, 12.5, dw - 24), { size: 12.5, fill: P.text2, mono: true }))
        ly += 19
      }
      dy += boxH + 10
    } else if (item.kind === 'meta') {
      inner.push(line(dx, dy - 12, dx + dw, dy - 12))
      inner.push(text(dx, dy + 6, item.label, { size: 12, fill: P.text3 }))
      inner.push(text(dx + dw, dy + 6, item.value, { size: 12, fill: P.text2, anchor: 'end' }))
      dy += 26
    } else if (item.kind === 'image') {
      inner.push(rect(dx, dy - 10, dw, item.height ?? 130, { fill: P.raised, r: 8, stroke: P.border }))
      inner.push(
        text(dx + dw / 2, dy + (item.height ?? 130) / 2 - 6, item.caption ?? '', {
          size: 12,
          fill: P.text3,
          anchor: 'middle',
        }),
      )
      dy += (item.height ?? 130) + 14
    }
  }

  inner.push(footer(x, y + h - FOOTER_H, w, scene.footer ?? {}))
  return svgDoc(w + MARGIN * 2, h + MARGIN * 2, inner.join('\n'))
}

const wrap = (s, size, maxWidth) => {
  const words = String(s).split(' ')
  const lines = []
  let cur = ''
  for (const word of words) {
    const next = cur ? cur + ' ' + word : word
    if (widthOf(next, size) > maxWidth && cur) {
      lines.push(cur)
      cur = word
    } else {
      cur = next
    }
  }
  if (cur) lines.push(cur)
  return lines
}

/** A standalone extension-owned window (Notes, AI Chat). */
function renderWindow(scene) {
  const w = scene.width ?? 820
  const h = scene.height ?? 520
  const x = MARGIN
  const y = MARGIN
  const inner = []

  inner.push(windowFrame(x, y, w, h))

  // Title strip.
  inner.push(drawIcon(x + 16, y + 15, 20, scene.icon ?? { bg: '#6236FF', glyph: '⚡' }))
  inner.push(text(x + 46, y + 30, scene.title, { size: 14, fill: P.text, weight: 600 }))
  if (scene.titleRight) {
    inner.push(text(x + w - 18, y + 30, scene.titleRight, { size: 12.5, fill: P.text3, anchor: 'end' }))
  }
  inner.push(line(x + 1, y + 50, x + w - 1, y + 50))

  let cy = y + 78
  const cx = x + 24
  const cw = w - 48
  for (const item of scene.content ?? []) {
    if (item.kind === 'heading') {
      inner.push(text(cx, cy, item.text, { size: 17, fill: P.text, weight: 600 }))
      cy += 30
    } else if (item.kind === 'para') {
      for (const ln of wrap(item.text, 13.5, cw)) {
        inner.push(text(cx, cy, ln, { size: 13.5, fill: P.text2 }))
        cy += 21
      }
      cy += 10
    } else if (item.kind === 'bullet') {
      inner.push(`<circle cx="${cx + 4}" cy="${cy - 4}" r="2.5" fill="${P.text3}"/>`)
      for (const [i, ln] of wrap(item.text, 13.5, cw - 20).entries()) {
        inner.push(text(cx + 16, cy + i * 21, ln, { size: 13.5, fill: P.text2 }))
      }
      cy += wrap(item.text, 13.5, cw - 20).length * 21 + 4
    } else if (item.kind === 'code') {
      const boxH = item.lines.length * 20 + 20
      inner.push(rect(cx, cy - 15, cw, boxH, { fill: P.raised, r: 8, stroke: P.border }))
      let ly = cy + 3
      for (const ln of item.lines) {
        inner.push(text(cx + 14, ly, clip(ln, 12.5, cw - 28), { size: 12.5, fill: P.text2, mono: true }))
        ly += 20
      }
      cy += boxH + 12
    } else if (item.kind === 'bubble') {
      const lines = wrap(item.text, 13.5, cw * 0.62 - 28)
      const bh = lines.length * 21 + 22
      const bw = Math.min(cw * 0.68, Math.max(...lines.map((l) => widthOf(l, 13.5))) + 32)
      const bx = item.from === 'user' ? cx + cw - bw : cx
      inner.push(
        rect(bx, cy - 16, bw, bh, {
          fill: item.from === 'user' ? P.selected : P.raised,
          r: 10,
          stroke: item.from === 'user' ? 'none' : P.border,
        }),
      )
      for (const [i, ln] of lines.entries()) {
        inner.push(text(bx + 16, cy + i * 21, ln, { size: 13.5, fill: item.from === 'user' ? P.text : P.text2 }))
      }
      cy += bh + 14
    } else if (item.kind === 'spacer') {
      cy += item.height ?? 16
    }
  }

  if (scene.input) {
    const iy = y + h - 62
    inner.push(rect(x + 16, iy, w - 32, 44, { fill: P.raised, r: 10, stroke: P.border }))
    inner.push(text(x + 32, iy + 27, scene.input, { size: 13.5, fill: P.text3 }))
    const cap = kbd(x + w - 30, iy + 22, '↵')
    inner.push(cap.svg)
  }
  return svgDoc(w + MARGIN * 2, h + MARGIN * 2, inner.join('\n'))
}

/** The Settings window: sidebar plus a pane of controls. */
function renderSettings(scene) {
  const w = scene.width ?? 900
  const h = scene.height ?? 560
  const x = MARGIN
  const y = MARGIN
  const sidebarW = 230   // .openray-settings-sidebar width
  const inner = []

  inner.push(windowFrame(x, y, w, h))
  inner.push(rect(x + 1, y + 1, sidebarW, h - 2, { fill: P.raised, r: 0 }))
  inner.push(
    `<path d="M${x + 1} ${y + h - RADIUS} a${RADIUS} ${RADIUS} 0 0 0 ${RADIUS} ${RADIUS} h${sidebarW - RADIUS} v-${RADIUS + 1} z" fill="${P.raised}"/>`,
  )
  inner.push(line(x + sidebarW, y + 1, x + sidebarW, y + h - 1))

  // Sidebar search field.
  inner.push(rect(x + 12, y + 14, sidebarW - 24, 30, { fill: P.bg, r: 7, stroke: P.border }))
  inner.push(searchIcon(x + 22, y + 22))
  inner.push(text(x + 46, y + 34, 'Search settings…', { size: 12.5, fill: P.text3 }))

  // The list scrolls in the real window, so clip it to the frame rather than
  // letting rows spill past the bottom edge.
  inner.push(`<clipPath id="rail"><rect x="${x + 1}" y="${y + 52}" width="${sidebarW - 1}" height="${h - 53}"/></clipPath>`)
  inner.push(`<g clip-path="url(#rail)">`)

  let sy = y + 58 - (scene.railScroll ?? 0)
  for (const item of scene.sidebar ?? []) {
    if (item.group) {
      sy += 10
      inner.push(text(x + 20, sy + 12, item.group, { size: 11, fill: P.text3, weight: 600 }))
      if (item.group === 'Extensions') {
        inner.push(text(x + sidebarW - 20, sy + 13, '+', { size: 15, fill: P.text3, weight: 500, anchor: 'end' }))
      }
      sy += 24
      continue
    }
    if (item.active) inner.push(rect(x + 10, sy, sidebarW - 20, 30, { fill: P.accent, r: 7 }))
    inner.push(drawIcon(x + 20, sy + 6, 18, item.icon ?? { letter: item.title[0] }))
    inner.push(
      text(x + 46, sy + 20, clip(item.title, 13, sidebarW - 70, 500), {
        size: 13,
        fill: item.active ? '#ffffff' : P.text,
        weight: 500,
      }),
    )
    sy += 32
  }
  inner.push('</g>')

  // Pane.
  const px = x + sidebarW + 32
  const pw = w - sidebarW - 64
  let py = y + 42
  inner.push(text(px, py, scene.pane.title, { size: 18, fill: P.text, weight: 600 }))
  py += 34

  for (const field of scene.pane.fields) {
    const labelW = 150
    if (field.label) {
      inner.push(text(px + labelW - 12, py + 15, field.label, { size: 13, fill: P.text2, anchor: 'end' }))
    }
    const fx = px + labelW
    const fw = pw - labelW

    if (field.kind === 'hotkey' || field.kind === 'input') {
      inner.push(rect(fx, py, Math.min(fw, 250), 30, { fill: P.raised, r: 7, stroke: P.border }))
      inner.push(text(fx + 12, py + 20, field.value, { size: 13, fill: P.text }))
      py += 42
    } else if (field.kind === 'select') {
      const sw = Math.min(fw, 220)
      inner.push(rect(fx, py, sw, 30, { fill: P.raised, r: 7, stroke: P.border }))
      inner.push(text(fx + 12, py + 20, field.value, { size: 13, fill: P.text }))
      inner.push(chevron(fx + sw - 20, py + 15))
      py += 42
    } else if (field.kind === 'segmented') {
      const segW = 92
      const total = field.options.length * segW
      inner.push(rect(fx, py, total, 30, { fill: P.raised, r: 7, stroke: P.border }))
      field.options.forEach((opt, i) => {
        if (i === field.active) inner.push(rect(fx + i * segW + 2, py + 2, segW - 4, 26, { fill: P.selected, r: 5 }))
        inner.push(
          text(fx + i * segW + segW / 2, py + 20, opt, {
            size: 12.5,
            fill: i === field.active ? P.text : P.text2,
            weight: i === field.active ? 600 : 400,
            anchor: 'middle',
          }),
        )
      })
      py += 42
    } else if (field.kind === 'toggle') {
      const on = field.value !== false
      inner.push(rect(fx, py + 3, 38, 22, { fill: on ? P.accent : P.selected, r: 11 }))
      inner.push(`<circle cx="${fx + (on ? 27 : 11)}" cy="${py + 14}" r="8.5" fill="#ffffff"/>`)
      if (field.hint) inner.push(text(fx + 50, py + 18, field.hint, { size: 12.5, fill: P.text3 }))
      py += 36
    } else if (field.kind === 'checkbox') {
      inner.push(rect(fx, py + 2, 18, 18, { fill: field.value ? P.accent : 'none', r: 5, stroke: field.value ? P.accent : P.border }))
      if (field.value) inner.push(checkMark(fx + 4, py + 10, '#ffffff'))
      inner.push(text(fx + 28, py + 16, field.hint ?? '', { size: 13, fill: P.text }))
      py += 32
    } else if (field.kind === 'range') {
      const trackW = Math.min(fw - 60, 220)
      inner.push(rect(fx, py + 12, trackW, 4, { fill: P.selected, r: 2 }))
      inner.push(rect(fx, py + 12, Math.round(trackW * field.fraction), 4, { fill: P.accent, r: 2 }))
      inner.push(`<circle cx="${fx + Math.round(trackW * field.fraction)}" cy="${py + 14}" r="8" fill="#ffffff"/>`)
      inner.push(text(fx + trackW + 14, py + 19, field.value, { size: 12.5, fill: P.text2 }))
      py += 36
    } else if (field.kind === 'button') {
      const bw = Math.ceil(widthOf(field.value, 13, 500)) + 28
      inner.push(rect(fx, py, bw, 30, { fill: field.primary ? P.accent : P.raised, r: 7, stroke: field.primary ? 'none' : P.border }))
      inner.push(text(fx + bw / 2, py + 20, field.value, { size: 13, fill: field.primary ? '#ffffff' : P.text, weight: 500, anchor: 'middle' }))
      py += 44
    } else if (field.kind === 'separator') {
      inner.push(line(fx - labelW, py + 6, fx - labelW + pw, py + 6))
      py += 24
    } else if (field.kind === 'note') {
      for (const ln of wrap(field.hint, 12.5, pw - labelW)) {
        inner.push(text(fx, py + 12, ln, { size: 12.5, fill: P.text3 }))
        py += 18
      }
      py += 10
    } else if (field.kind === 'table') {
      const rowH = 34
      const tableH = field.rows.length * rowH + 30
      inner.push(rect(fx - labelW, py, pw, tableH, { fill: P.raised, r: 8, stroke: P.border }))
      inner.push(text(fx - labelW + 14, py + 20, field.headers[0], { size: 11.5, fill: P.text3, weight: 600 }))
      inner.push(
        text(fx - labelW + pw - 14, py + 20, field.headers[1], {
          size: 11.5,
          fill: P.text3,
          weight: 600,
          anchor: 'end',
        }),
      )
      field.rows.forEach((r, i) => {
        const ry = py + 30 + i * rowH
        if (r.active) inner.push(rect(fx - labelW + 4, ry, pw - 8, rowH - 2, { fill: P.accent, r: 6 }))
        inner.push(drawIcon(fx - labelW + 14, ry + (rowH - 20) / 2, 20, r.icon ?? { letter: r.title[0] }))
        inner.push(
          text(fx - labelW + 44, ry + rowH / 2 + 4, r.title, {
            size: 13,
            fill: r.active ? '#ffffff' : P.text,
            weight: 500,
          }),
        )
        inner.push(
          text(fx - labelW + pw - 14, ry + rowH / 2 + 4, r.value, {
            size: 12.5,
            fill: r.active ? '#ffffff' : P.text3,
            anchor: 'end',
          }),
        )
      })
      py += tableH + 16
    }
  }
  return svgDoc(w + MARGIN * 2, h + MARGIN * 2, inner.join('\n'))
}

/** The palette on a coloured backdrop, for the landing page and README. */
function renderHero(scene) {
  const w = 1200
  const h = 700
  const paletteW = 780
  const bodyH = listHeight(scene.sections)
  const ph = SEARCH_H + bodyH + FOOTER_H
  const px = Math.round((w - paletteW) / 2)
  const py = Math.round((h - ph) / 2)
  const inner = []

  inner.push(rect(0, 0, w, h, { fill: 'url(#hero-bg)', r: 24 }))
  inner.push(rect(0, 0, w, h, { fill: 'url(#hero-glow)', r: 24 }))
  // A few soft shapes so the backdrop reads as a desktop rather than flat paint.
  inner.push(`<circle cx="150" cy="120" r="86" fill="#ffffff" opacity="0.07"/>`)
  inner.push(`<circle cx="1080" cy="600" r="130" fill="#ffffff" opacity="0.06"/>`)
  inner.push(rect(880, 70, 250, 150, { fill: '#ffffff', r: 16, opacity: 0.06 }))
  inner.push(rect(70, 470, 210, 160, { fill: '#ffffff', r: 16, opacity: 0.05 }))

  inner.push(windowFrame(px, py, paletteW, ph))
  inner.push(searchBar(px, py, paletteW, scene))
  inner.push(listBody(px, py + SEARCH_H, paletteW, scene.sections, scene.selected ?? 0))
  inner.push(footer(px, py + ph - FOOTER_H, paletteW, scene.footer ?? {}))
  return svgDoc(w, h, inner.join('\n'))
}


/**
 * A Grid command — the emoji picker's shape. Metrics from palette.css's
 * .openray-grid / .openray-grid-cell: 10 columns for emoji, 10px gap, 12px
 * padding, square cells with a 34px glyph and a 2px accent border when
 * selected.
 */
function renderGrid(scene) {
  const w = scene.width ?? WIDTH
  const cols = scene.columns ?? 10
  const gap = 10
  const gridPad = 12
  const cell = (w - gridPad * 2 - gap * (cols - 1)) / cols
  const titleH = 24

  let bodyH = gridPad
  for (const section of scene.sections) {
    bodyH += section.title ? titleH : 0
    bodyH += Math.ceil(section.items.length / cols) * (cell + gap)
  }
  bodyH += gridPad - gap

  const h = SEARCH_H + bodyH + FOOTER_H
  const x = MARGIN
  const y = MARGIN
  const inner = [windowFrame(x, y, w, h), searchBar(x, y, w, scene)]

  // The category dropdown sits at the trailing edge of the search bar.
  if (scene.filter) {
    const fw = Math.ceil(widthOf(scene.filter, 13, 500)) + 34
    inner.push(rect(x + w - 18 - fw, y + SEARCH_H / 2 - 13, fw, 26, { fill: P.raised, r: 7, stroke: P.border }))
    inner.push(text(x + w - 18 - fw + 11, y + SEARCH_H / 2 + 4.5, scene.filter, { size: 13, fill: P.text, weight: 500 }))
    inner.push(chevron(x + w - 18 - 20, y + SEARCH_H / 2 - 1))
  }

  let cy = y + SEARCH_H + gridPad
  let index = 0
  for (const section of scene.sections) {
    if (section.title) {
      inner.push(text(x + gridPad + 2, cy + 16, section.title, { size: 13, fill: P.text2 }))
      cy += titleH
    }
    section.items.forEach((glyph, i) => {
      const col = i % cols
      const row = Math.floor(i / cols)
      const cx = x + gridPad + col * (cell + gap)
      const ty = cy + row * (cell + gap)
      const selected = index === (scene.selected ?? -1)
      if (selected) {
        inner.push(rect(cx - 2, ty - 2, cell + 4, cell + 4, { fill: P.selected, r: 10, stroke: P.accent, strokeWidth: 2 }))
      }
      inner.push(rect(cx, ty, cell, cell, { fill: P.selected, r: 8 }))
      inner.push(text(cx + cell / 2, ty + cell / 2 + 12, glyph, { size: 34, anchor: 'middle' }))
      index += 1
    })
    cy += Math.ceil(section.items.length / cols) * (cell + gap)
  }

  inner.push(footer(x, y + h - FOOTER_H, w, scene.footer ?? {}))
  return svgDoc(w + MARGIN * 2, h + MARGIN * 2, inner.join('\n'))
}

const RENDERERS = {
  palette: renderPalette,
  grid: renderGrid,
  detail: renderDetail,
  window: renderWindow,
  settings: renderSettings,
  hero: renderHero,
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenes
// ─────────────────────────────────────────────────────────────────────────────

// Names from the app's own SYSTEM_ICON_NAMES, so each row draws the glyph
// the palette would draw. Applications are the exception: the palette shows
// their real artwork, so those stay coloured tiles.
const ICON = {
  openray: 'app-window',
  clipboard: 'clipboard',
  snippet: 'scissors',
  quicklink: 'link',
  window: 'window-center',
  windowLeft: 'window-left-half',
  windowRight: 'window-right-half',
  windowMax: 'window-maximize',
  windowAlmost: 'window-almost-maximize',
  windowTop: 'window-top-half',
  windowBottom: 'window-bottom-half',
  windowMove: 'window-move',
  system: 'power',
  monitor: 'monitor',
  script: 'code',
  emoji: 'smiley',
  file: 'search',
  fileItem: 'file',
  folder: 'folder',
  shot: 'camera',
  note: 'note',
  translate: 'translate',
  menubar: 'monitor',
  ai: 'sparkles',
  store: 'app-window',
  calc: 'calculator',
  settings: 'settings',
  transfer: 'swap',
  advanced: 'crosshair',
  plus: 'plus',
  copy: 'copy',
  mail: 'mail',
  text: 'text',
  drag: 'drag',
  appWindow: 'app-window',
  // Installed applications — real artwork in the palette.
  safari: { bg: '#0b84ff', glyph: 'S' },
  code: { bg: '#1f6feb', glyph: '{}' },
  terminal: { bg: '#2f2f31', glyph: '>' },
  figma: { bg: '#e5484d', glyph: 'F' },
  slack: { bg: '#4a154b', glyph: '#' },
  notion: { bg: '#f2f2f2', fg: '#1b1b1b', glyph: 'N' },
  spotify: { bg: '#1db954', glyph: '♪' },
}

const SETTINGS_RAIL = (activeTitle) => {
  const rows = [
    { group: 'Settings' },
    { title: 'General', icon: 'settings' },
    { title: 'Import / Export', icon: 'swap' },
    { title: 'Advanced', icon: 'crosshair' },
    { group: 'Extensions' },
    { title: 'Applications', icon: 'app-window' },
    { title: 'AI', icon: 'sparkles' },
    { title: 'Calculator', icon: 'calculator' },
    { title: 'Clipboard History', icon: 'clipboard' },
    { title: 'Developer', icon: 'code' },
    { title: 'Emoji & Symbols', icon: 'smiley' },
    { title: 'File Search', icon: 'search' },
    { title: 'Menu Bar Search', icon: 'monitor' },
    { title: 'Notes', icon: 'note' },
    { title: 'Quicklinks', icon: 'link' },
    { title: 'Screenshots', icon: 'camera' },
    { title: 'Script Commands', icon: 'code' },
    { title: 'Snippets', icon: 'scissors' },
    { title: 'Store', icon: 'app-window' },
    { title: 'Switch Windows', icon: 'window-move' },
    { title: 'System Commands', icon: 'power' },
    { title: 'Translate', icon: 'translate' },
    { title: 'Window Management', icon: 'window-center' },
  ]
  return rows.map((r) => (r.title === activeTitle ? { ...r, active: true } : r))
}

const OPEN_ACTIONS = [
  { label: 'Open', keys: ['↵'] },
  { label: 'Actions', keys: ['⌘', 'K'] },
]

const ROOT_SECTIONS = [
  {
    title: 'Applications',
    rows: [
      { icon: ICON.safari, title: 'Safari', accessory: 'Application' },
      { icon: ICON.figma, title: 'Figma', accessory: 'Application' },
      { icon: ICON.slack, title: 'Slack', accessory: 'Application' },
    ],
  },
  {
    title: 'Commands',
    rows: [
      { icon: ICON.clipboard, title: 'Clipboard History', subtitle: 'Clipboard History', accessory: 'Command' },
      { icon: ICON.snippet, title: 'Search Snippets', subtitle: 'Snippets', accessory: 'Command' },
      { icon: ICON.windowLeft, title: 'Left Half', subtitle: 'Window Management', accessory: 'Command' },
      { icon: ICON.ai, title: 'AI Chat', subtitle: 'AI', accessory: 'Command' },
      { icon: ICON.store, title: 'Store', subtitle: 'Store', accessory: 'Command' },
    ],
  },
]

const SCENES = [
  {
    name: 'hero',
    kind: 'hero',
    query: '',
    selected: 3,
    sections: ROOT_SECTIONS,
    footer: { command: 'Clipboard History', icon: ICON.clipboard, actions: OPEN_ACTIONS },
  },
  {
    name: 'root-search',
    kind: 'palette',
    query: '',
    selected: 0,
    sections: ROOT_SECTIONS,
    footer: { command: 'Safari', icon: ICON.safari, actions: OPEN_ACTIONS },
  },
  {
    name: 'applications',
    kind: 'palette',
    query: 'saf',
    selected: 0,
    sections: [
      {
        title: 'Applications',
        rows: [
          { icon: ICON.safari, title: 'Safari', accessory: 'Application', hint: '↵' },
          { icon: ICON.code, title: 'Safari Technology Preview', accessory: 'Application' },
        ],
      },
      {
        title: 'Use with…',
        rows: [
          { icon: ICON.file, title: 'Search Files', subtitle: 'File Search', accessory: 'Command' },
          { icon: ICON.ai, title: 'Ask AI', subtitle: 'AI', accessory: 'Command' },
        ],
      },
    ],
    footer: { command: 'Safari', icon: ICON.safari, actions: OPEN_ACTIONS },
  },
  {
    name: 'calculator',
    kind: 'palette',
    query: '(1024 * 8) / (2 + 6',
    inline: { label: 'Calculator', value: '1,024', hint: '(1024 * 8) / (2 + 6)' },
    empty: 'No results',
    bodyHeight: 92 + 56,
    footer: { command: 'Calculator', icon: ICON.calc, actions: [{ label: 'Copy', keys: ['↵'] }, { label: 'Actions', keys: ['⌘', 'K'] }] },
  },
  {
    name: 'clipboard-history',
    kind: 'detail',
    back: true,
    query: '',
    placeholder: 'Search your clipboard history…',
    selected: 1,
    bodyHeight: 300,
    sections: [
      {
        rows: [
          { icon: ICON.terminal, title: 'pnpm --filter openray-website dev', accessory: '2m' },
          { icon: ICON.clipboard, title: 'https://github.com/tuanpham-dev/openray', accessory: '14m' },
          { icon: ICON.shot, title: 'Screenshot 2026-09-07 at 18.02.png', accessory: '1h' },
          { icon: ICON.mail, title: 'hello@example.com', accessory: '3h' },
          { icon: ICON.clipboard, title: 'The quick brown fox jumps over…', accessory: 'Yesterday' },
          { icon: ICON.terminal, title: 'git rebase --continue', accessory: 'Yesterday' },
          { icon: ICON.clipboard, title: '#6236FF', accessory: '2d' },
        ],
      },
    ],
    detail: [
      { kind: 'heading', text: 'Link' },
      { kind: 'code', lines: ['https://github.com/', 'tuanpham-dev/openray'] },
      { kind: 'meta', label: 'Copied', value: '14 minutes ago' },
      { kind: 'meta', label: 'Application', value: 'Safari' },
      { kind: 'meta', label: 'Characters', value: '44' },
      { kind: 'meta', label: 'Type', value: 'Link' },
    ],
    footer: { command: 'Clipboard History', icon: ICON.clipboard, actions: [{ label: 'Paste', keys: ['↵'] }, { label: 'Actions', keys: ['⌘', 'K'] }] },
  },
  {
    name: 'snippets',
    kind: 'palette',
    back: true,
    query: '',
    placeholder: 'Search snippets…',
    selected: 2,
    sections: [
      {
        title: 'Snippets',
        rows: [
          { icon: ICON.snippet, title: 'Address', subtitle: ';addr', accessory: 'Snippet' },
          { icon: ICON.snippet, title: 'Bank Details', subtitle: ';bank', accessory: 'Snippet' },
          { icon: ICON.snippet, title: 'Email Signature', subtitle: ';sig', accessory: 'Snippet', hint: '↵' },
          { icon: ICON.snippet, title: 'Meeting Follow-up', subtitle: ';followup', accessory: 'Snippet' },
          { icon: ICON.snippet, title: 'PR Description', subtitle: ';pr', accessory: 'Snippet' },
          { icon: ICON.snippet, title: 'Today’s Date', subtitle: ';date', accessory: 'Snippet' },
        ],
      },
    ],
    footer: { command: 'Search Snippets', icon: ICON.snippet, actions: [{ label: 'Paste Snippet', keys: ['↵'] }, { label: 'Actions', keys: ['⌘', 'K'] }] },
  },
  {
    name: 'quicklinks',
    kind: 'palette',
    back: true,
    query: '',
    placeholder: 'Search quicklinks…',
    selected: 0,
    sections: [
      {
        title: 'Quicklinks',
        rows: [
          { icon: ICON.quicklink, title: 'Search GitHub', subtitle: 'github.com/search?q={argument}', hint: '↵' },
          { icon: ICON.quicklink, title: 'Open Downloads', subtitle: '~/Downloads' },
          { icon: ICON.quicklink, title: 'Translate Clipboard', subtitle: 'translate.google.com/?text={clipboard}' },
          { icon: ICON.quicklink, title: 'Jira Ticket', subtitle: 'jira.example.com/browse/{argument}' },
          { icon: ICON.quicklink, title: 'Design System', subtitle: 'figma.com/file/…' },
        ],
      },
    ],
    footer: { command: 'Search Quicklinks', icon: ICON.quicklink, actions: [{ label: 'Open', keys: ['↵'] }, { label: 'Actions', keys: ['⌘', 'K'] }] },
  },
  {
    name: 'window-management',
    kind: 'palette',
    query: 'half',
    selected: 0,
    sections: [
      {
        title: 'Window Management',
        rows: [
          { icon: ICON.windowLeft, title: 'Left Half', accessory: 'Command', hint: '↵' },
          { icon: ICON.windowRight, title: 'Right Half', accessory: 'Command' },
          { icon: ICON.windowTop, title: 'Top Half', accessory: 'Command' },
          { icon: ICON.windowBottom, title: 'Bottom Half', accessory: 'Command' },
          { icon: ICON.windowAlmost, title: 'Almost Maximize', accessory: 'Command' },
          { icon: ICON.windowMax, title: 'Maximize', accessory: 'Command' },
        ],
      },
    ],
    footer: { command: 'Left Half', icon: ICON.window, actions: OPEN_ACTIONS },
  },
  {
    name: 'switch-windows',
    kind: 'palette',
    back: true,
    query: '',
    placeholder: 'Search open windows…',
    selected: 1,
    sections: [
      {
        title: 'Open Windows',
        rows: [
          { icon: ICON.code, title: 'openray — README.md', subtitle: 'Visual Studio Code' },
          { icon: ICON.safari, title: 'OpenRay documentation', subtitle: 'Safari', hint: '↵' },
          { icon: ICON.figma, title: 'Design System — Components', subtitle: 'Figma' },
          { icon: ICON.slack, title: '#engineering', subtitle: 'Slack' },
          { icon: ICON.terminal, title: 'pnpm dev', subtitle: 'Terminal' },
        ],
      },
    ],
    footer: { command: 'Switch Windows', icon: ICON.window, actions: [{ label: 'Focus Window', keys: ['↵'] }, { label: 'Actions', keys: ['⌘', 'K'] }] },
  },
  {
    name: 'system-commands',
    kind: 'palette',
    query: 'volume',
    selected: 0,
    // Every system command carries the subtitle "System" and its own icon
    // (extensions/system-commands/src/{list,table}.ts); a query puts them
    // under root search's "Results" heading.
    sections: [
      {
        title: 'Results',
        rows: [
          { icon: 'volume-2', title: 'Turn Volume Up', subtitle: 'System', accessory: 'Command', hint: '↵' },
          { icon: 'volume-1', title: 'Turn Volume Down', subtitle: 'System', accessory: 'Command' },
          { icon: 'volume-x', title: 'Set Volume to 0%', subtitle: 'System', accessory: 'Command' },
          { icon: 'volume', title: 'Set Volume to 25%', subtitle: 'System', accessory: 'Command' },
          { icon: 'volume-1', title: 'Set Volume to 50%', subtitle: 'System', accessory: 'Command' },
          { icon: 'volume-2', title: 'Set Volume to 75%', subtitle: 'System', accessory: 'Command' },
          { icon: 'volume-2', title: 'Set Volume to 100%', subtitle: 'System', accessory: 'Command' },
        ],
      },
    ],
    footer: { command: 'Turn Volume Up', icon: 'volume-2', actions: OPEN_ACTIONS },
  },
  {
    name: 'script-commands',
    kind: 'palette',
    query: '',
    selected: 1,
    sections: [
      {
        title: 'Script Commands',
        rows: [
          { icon: ICON.script, title: 'Clear DNS Cache', subtitle: 'flush-dns.sh', accessory: 'Script' },
          { icon: ICON.script, title: 'Current IP Address', subtitle: 'ip.sh', accessory: 'Script', hint: '↵' },
          { icon: ICON.script, title: 'Start Dev Server', subtitle: 'dev.sh', accessory: 'Script' },
          { icon: ICON.script, title: 'Toggle Dark Mode', subtitle: 'appearance.sh', accessory: 'Script' },
        ],
      },
    ],
    footer: { command: 'Current IP Address', icon: ICON.script, actions: [{ label: 'Run Script', keys: ['↵'] }, { label: 'Actions', keys: ['⌘', 'K'] }] },
  },
  {
    name: 'emoji',
    kind: 'grid',
    back: true,
    query: '',
    placeholder: 'Search emoji & symbols…',
    filter: 'All Categories',
    columns: 10,
    selected: 3,
    sections: [
      {
        title: 'Recently Used',
        items: ['🚀', '✅', '🎉', '👀', '🔥', '💡', '🙏', '⚠️', '📌', '☕'],
      },
      {
        title: 'Smileys & Emotion',
        items: ['😀', '😃', '😄', '😁', '😆', '😅', '😂', '🙂', '🙃', '😉',
                '😊', '😇', '🥰', '😍', '🤩', '😘', '😗', '😚', '😙', '😋'],
      },
    ],
    footer: { command: 'Search Emoji & Symbols', icon: 'smiley', actions: [{ label: 'Paste Emoji', keys: ['↵'] }, { label: 'Actions', keys: ['⌘', 'K'] }] },
  },
  {
    name: 'file-search',
    kind: 'palette',
    back: true,
    query: 'invoice',
    selected: 0,
    sections: [
      {
        title: 'Files',
        rows: [
          { icon: ICON.fileItem, title: 'Invoice-2026-08.pdf', subtitle: '~/Documents/Invoices', hint: '↵' },
          { icon: ICON.fileItem, title: 'Invoice-2026-07.pdf', subtitle: '~/Documents/Invoices' },
          { icon: ICON.fileItem, title: 'invoice-template.numbers', subtitle: '~/Documents/Templates' },
          { icon: ICON.fileItem, title: 'invoices', subtitle: '~/Documents', accessory: 'Folder' },
        ],
      },
    ],
    footer: { command: 'Search Files', icon: ICON.file, actions: [{ label: 'Open File', keys: ['↵'] }, { label: 'Actions', keys: ['⌘', 'K'] }] },
  },
  {
    name: 'screenshots',
    kind: 'detail',
    back: true,
    query: '',
    placeholder: 'Search screenshots and recordings…',
    selected: 0,
    bodyHeight: 310,
    sections: [
      {
        rows: [
          { icon: ICON.shot, title: 'Screenshot 2026-09-07 at 18.02.png', accessory: 'Today' },
          { icon: ICON.shot, title: 'Screenshot 2026-09-07 at 11.40.png', accessory: 'Today' },
          { icon: ICON.shot, title: 'Screen Recording 2026-09-06.mov', accessory: 'Yesterday' },
          { icon: ICON.shot, title: 'Screenshot 2026-09-05 at 09.13.png', accessory: '2 Sept' },
          { icon: ICON.shot, title: 'Screenshot 2026-09-04 at 20.55.png', accessory: '3 Sept' },
        ],
      },
    ],
    detail: [
      { kind: 'image', height: 150, caption: 'Preview' },
      { kind: 'meta', label: 'Taken', value: 'Today at 18:02' },
      { kind: 'meta', label: 'Size', value: '1.8 MB' },
      { kind: 'meta', label: 'Dimensions', value: '2880 × 1800' },
    ],
    footer: { command: 'Search Screenshots', icon: ICON.shot, actions: [{ label: 'Paste', keys: ['↵'] }, { label: 'Actions', keys: ['⌘', 'K'] }] },
  },
  {
    name: 'notes',
    kind: 'window',
    icon: ICON.note,
    title: 'Release checklist',
    titleRight: 'Edited just now',
    width: 780,
    height: 360,
    content: [
      { kind: 'heading', text: 'Release checklist' },
      { kind: 'para', text: 'Everything that has to happen before tagging a build, in order.' },
      { kind: 'bullet', text: 'Run the QA checklist on macOS and Linux' },
      { kind: 'bullet', text: 'Regenerate the icon set from icon.svg' },
      { kind: 'bullet', text: 'Bump the version in package.json' },
      { kind: 'spacer', height: 8 },
      { kind: 'code', lines: ['git tag v0.2.0', 'git push origin v0.2.0'] },
    ],
  },
  {
    name: 'translate',
    kind: 'palette',
    query: 'bonjour tout le monde',
    inline: { label: 'Translate · French → English', value: 'Hello everyone', hint: 'Copy Translation' },
    selected: 0,
    sections: [
      {
        title: 'Translate',
        rows: [
          { icon: ICON.translate, title: 'Open in Translate', subtitle: 'Translate', accessory: 'Command', hint: '↵' },
          { icon: ICON.translate, title: 'French → German', subtitle: 'Translate', accessory: 'Command' },
        ],
      },
    ],
    footer: { command: 'Translate', icon: ICON.translate, actions: [{ label: 'Copy Translation', keys: ['↵'] }, { label: 'Actions', keys: ['⌘', 'K'] }] },
  },
  {
    name: 'menu-bar-search',
    kind: 'palette',
    back: true,
    query: 'export',
    selected: 0,
    sections: [
      {
        title: 'Figma',
        rows: [
          { icon: ICON.menubar, title: 'Export…', subtitle: 'File', accessory: '⇧⌘E', hint: '↵' },
          { icon: ICON.menubar, title: 'Export Selection as PNG', subtitle: 'File' },
          { icon: ICON.menubar, title: 'Copy as PNG', subtitle: 'Edit', accessory: '⇧⌘C' },
        ],
      },
    ],
    footer: { command: 'Search Menu Bar Items', icon: ICON.menubar, actions: [{ label: 'Trigger Item', keys: ['↵'] }, { label: 'Actions', keys: ['⌘', 'K'] }] },
  },
  {
    name: 'ai-chat',
    kind: 'window',
    icon: ICON.ai,
    title: 'AI Chat',
    titleRight: 'Claude Sonnet 5',
    width: 800,
    height: 450,
    input: 'Ask anything…',
    content: [
      { kind: 'bubble', from: 'user', text: 'Summarise what changed in this diff and suggest a commit message.' },
      {
        kind: 'bubble',
        from: 'ai',
        text: 'The change adds a Pages workflow and moves the technical README sections into the docs site. Suggested message:',
      },
      { kind: 'code', lines: ['docs: publish the manual and landing page', '', 'Move architecture, extension authoring and', 'platform notes out of the README.'] },
    ],
  },
  {
    name: 'ai-root',
    kind: 'palette',
    query: 'writing',
    selected: 0,
    sections: [
      {
        title: 'Results',
        rows: [
          { icon: ICON.ai, title: 'Improve Writing', subtitle: 'Built-in AI Command', hint: '↵' },
          { icon: ICON.ai, title: 'Fix Spelling and Grammar', subtitle: 'Built-in AI Command' },
          { icon: ICON.ai, title: 'Change Tone to Professional', subtitle: 'Built-in AI Command' },
          { icon: ICON.ai, title: 'Release Notes Writer', subtitle: 'AI Command' },
          { icon: ICON.ai, title: 'New Chat with Editor', subtitle: 'Agent' },
        ],
      },
    ],
    footer: { command: 'Improve Writing', icon: ICON.ai, actions: OPEN_ACTIONS },
  },
  {
    name: 'store',
    kind: 'detail',
    back: true,
    query: '',
    placeholder: 'Search extensions…',
    selected: 0,
    bodyHeight: 250,
    sections: [
      {
        rows: [
          { icon: ICON.terminal, title: 'Brew', accessory: '1.4.0', tag: 'Install', tagColor: '#34c759' },
          { icon: ICON.code, title: 'GitHub', accessory: '2.1.3', tag: 'Update', tagColor: '#007aff' },
          { icon: ICON.spotify, title: 'Spotify Controls', accessory: '0.9.1', tag: 'Install', tagColor: '#34c759' },
          { icon: ICON.notion, title: 'Notion Search', accessory: '1.0.2', tag: 'Install', tagColor: '#34c759' },
          { icon: ICON.mail, title: 'Hacker News', accessory: '1.2.0', tag: 'Installed' },
        ],
      },
    ],
    detail: [
      { kind: 'heading', text: 'Brew' },
      { kind: 'para', text: 'Search formulae and casks, then install or uninstall them without leaving the launcher.' },
      { kind: 'meta', label: 'Version', value: '1.4.0' },
      { kind: 'meta', label: 'Source', value: 'OpenRay Extensions' },
      { kind: 'meta', label: 'Commands', value: '4' },
      { kind: 'meta', label: 'Size', value: '212 KB' },
    ],
    footer: { command: 'Store', icon: ICON.store, actions: [{ label: 'Install', keys: ['↵'] }, { label: 'Actions', keys: ['⌘', 'K'] }] },
  },
  {
    name: 'settings-general',
    kind: 'settings',
    width: 980,
    height: 620,
    sidebar: SETTINGS_RAIL('General'),
    pane: {
      title: 'General',
      fields: [
        { kind: 'hotkey', label: 'Hotkey', value: '⌘ Space' },
        { kind: 'toggle', label: 'Launch at Login', value: true },
        { kind: 'toggle', label: 'Show Tray Icon', value: true },
        { kind: 'separator' },
        { kind: 'segmented', label: 'Appearance', options: ['Light', 'Dark', 'System'], active: 1 },
        { kind: 'segmented', label: 'Window Size', options: ['Small', 'Medium', 'Large'], active: 1 },
        { kind: 'select', label: 'Text Size', value: 'Default' },
        { kind: 'select', label: 'Show on Screen', value: 'Screen with Cursor' },
        { kind: 'range', label: 'Background Opacity', fraction: 0.79, value: '85%' },
        { kind: 'toggle', label: 'Window Shadow', value: true },
      ],
    },
  },
  {
    name: 'settings-advanced',
    kind: 'settings',
    width: 980,
    height: 620,
    sidebar: SETTINGS_RAIL('Advanced'),
    pane: {
      title: 'Advanced',
      fields: [
        { kind: 'select', label: 'Pop to Root Search', value: 'After 90 seconds' },
        { kind: 'select', label: 'Root Search Sensitivity', value: 'Medium' },
        { kind: 'note', label: '', hint: 'Higher filters out weaker matches' },
        { kind: 'toggle', label: 'Vim Style Navigation', value: true, hint: 'Alt+J/K move through lists' },
      ],
    },
  },
  {
    name: 'settings-extensions',
    kind: 'settings',
    width: 980,
    height: 620,
    // Window Management is the last entry, so the rail is scrolled to it the
    // way the real sidebar scrolls the active row into view.
    railScroll: 210,
    sidebar: SETTINGS_RAIL('Window Management'),
    pane: {
      title: 'Window Management',
      fields: [
        {
          kind: 'table',
          headers: ['Command', 'Hotkey'],
          rows: [
            { icon: ICON.windowLeft, title: 'Left Half', value: '⌃⌥ ←', active: true },
            { icon: ICON.windowRight, title: 'Right Half', value: '⌃⌥ →' },
            { icon: ICON.windowMax, title: 'Maximize', value: '⌃⌥ ↵' },
            { icon: ICON.windowAlmost, title: 'Almost Maximize', value: 'Record Hotkey' },
            { icon: ICON.window, title: 'Center', value: 'Record Hotkey' },
          ],
        },
      ],
    },
  },
  {
    name: 'settings-import-export',
    kind: 'settings',
    width: 980,
    height: 620,
    sidebar: SETTINGS_RAIL('Import / Export'),
    pane: {
      title: 'Import / Export',
      fields: [
        { kind: 'checkbox', label: 'Core Data', value: true, hint: 'Command aliases and hotkeys, and your general settings' },
        { kind: 'checkbox', label: 'Extensions', value: true, hint: 'Each extension below exports its own data' },
        { kind: 'checkbox', label: 'Quicklinks', value: true, hint: 'Your saved quicklinks' },
        { kind: 'checkbox', label: 'Snippets', value: true, hint: 'Your saved snippets' },
        { kind: 'checkbox', label: 'Clipboard History', value: false, hint: 'Text entries only — copied images stay on this machine' },
        { kind: 'checkbox', label: 'Usage Counts', value: true, hint: 'Combined rather than overwritten when imported' },
        { kind: 'button', label: '', value: 'Export…', primary: true },
      ],
    },
  },
  {
    name: 'create-extension',
    kind: 'palette',
    back: true,
    query: '',
    placeholder: 'Choose a template…',
    selected: 0,
    sections: [
      {
        title: 'Templates',
        rows: [
          { icon: ICON.code, title: 'Show List', subtitle: 'A static list with icons, subtitles, and accessories', hint: '↵' },
          { icon: ICON.code, title: 'Show Detail', subtitle: 'A single markdown view' },
          { icon: ICON.code, title: 'Show List and Detail', subtitle: 'A list whose selection shows a detail pane' },
          { icon: ICON.code, title: 'Show Typeahead Results', subtitle: 'A searchable list that loads results as you type' },
          { icon: ICON.code, title: 'Submit Form', subtitle: 'Fields with a submit action' },
          { icon: ICON.code, title: 'Show Grid', subtitle: 'A grid of items' },
          { icon: ICON.code, title: 'Run Script', subtitle: 'Runs and shows a HUD, with no UI' },
        ],
      },
    ],
    footer: { command: 'Create Extension', icon: ICON.plus, actions: [{ label: 'Create', keys: ['↵'] }, { label: 'Actions', keys: ['⌘', 'K'] }] },
  },
]

function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  for (const scene of SCENES) {
    const render = RENDERERS[scene.kind]
    if (!render) throw new Error(`Unknown scene kind: ${scene.kind}`)
    writeFileSync(join(OUT_DIR, `${scene.name}.svg`), render(scene))
  }
  console.log(`Rendered ${SCENES.length} screenshots to public/screenshots/`)
}

main()
