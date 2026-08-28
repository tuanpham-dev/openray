import { useLayoutEffect, useRef, useState } from 'react'

/**
 * The rendered width of a string in an element's own font.
 *
 * Argument fields sit immediately after the query text, and both are sized
 * to their content — a stretched input would shove the fields to the far
 * edge, which is exactly what made ours look unlike Raycast's. Measuring is
 * the only way to do that with a proportional font; `ch` units assume a
 * monospace advance and run wide on this UI font.
 *
 * Uses a canvas rather than a mirror DOM node: no extra elements, and no
 * reflow on every keystroke.
 */
let measuringContext: CanvasRenderingContext2D | null | undefined

function measure(text: string, font: string): number {
  if (measuringContext === undefined) {
    measuringContext = document.createElement('canvas').getContext('2d')
  }
  if (!measuringContext) return 0
  measuringContext.font = font
  return measuringContext.measureText(text).width
}

interface AutoWidthOptions {
  /** Never narrower than this, so an empty field is still clickable. */
  min: number
  max: number
  /** Measured when the value is empty, so a field shows its whole hint. */
  placeholder?: string
}

/**
 * Returns a ref to attach to an input, and the width it should be.
 *
 * Falls back to a character-count estimate where text measurement isn't
 * available (jsdom has no canvas), so the component still renders sanely
 * under test.
 */
export function useAutoWidth<T extends HTMLElement>(
  value: string,
  { min, max, placeholder }: AutoWidthOptions,
): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(min)

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const text = value || placeholder || ''
    const style = window.getComputedStyle(element)
    const measured = style.font ? measure(text, style.font) : 0
    // A small trailing allowance so a caret at the end of the text isn't
    // clipped against the field's edge.
    const content = measured > 0 ? measured + 2 : text.length * 8
    // `width` is the border box under this UI's global `border-box` sizing,
    // so the padding and border have to be added back — leaving them out
    // made every field a couple of characters too narrow and scrolled the
    // text out of view.
    const chrome =
      style.boxSizing === 'border-box'
        ? ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth'].reduce(
            (total, property) => total + (Number.parseFloat(style[property as 'paddingLeft']) || 0),
            0,
          )
        : 0
    setWidth(Math.round(Math.min(max, Math.max(min, content + chrome))))
  }, [value, placeholder, min, max])

  return [ref, width]
}
