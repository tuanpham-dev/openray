import { matchLanguage, type Lang } from './languages'

/** Parses a root-search query into a translation intent — additive to
 * normal search results, never a replacement for them, so an occasional
 * false positive (`"log in french"` reads as "translate 'log' to
 * French") just costs one extra result row rather than hiding anything.
 * Ported line-for-line from `application/translate/intent.rs`.
 *
 * Two forms are recognized, checked in this order:
 * 1. `"<text> in|into <language>"` — explicit target, e.g. `"hello in
 *    german"`.
 * 2. `"translate <text>"` (or `"<alias> <text>"`, the Translate row's
 *    user-assigned alias, if any) — no explicit target; resolves to the
 *    caller's default target language. Checked second so `"translate
 *    hello in german"` still honors the explicit "in german" rather than
 *    falling back to the default. */
export interface Intent {
  text: string
  target: Lang
}

function isInWord(word: string): boolean {
  return word.toLowerCase() === 'in' || word.toLowerCase() === 'into'
}

function isPrefixWord(word: string, alias?: string): boolean {
  return word.toLowerCase() === 'translate' || (!!alias && word.toLowerCase() === alias.toLowerCase())
}

/** `defaultTarget` is the caller's resolved default target language
 * (`undefined` if the configured code doesn't match anything in the
 * table) — only consulted for the prefix form. `alias` is the Translate
 * row's user-assigned alias, if any (case-insensitive, alongside the
 * literal word "translate"). */
export function parseIntent(query: string, defaultTarget?: Lang, alias?: string): Intent | undefined {
  const words = query.split(/\s+/).filter(Boolean)
  const firstWord = words[0]
  const hasPrefix = firstWord !== undefined && isPrefixWord(firstWord, alias)
  const rest = hasPrefix ? words.slice(1) : words

  // Splits on the *last* standalone `in`/`into` word in `rest` (so
  // `"check in in german"` still resolves against the trailing one),
  // requires non-empty text on both sides, and requires what follows to
  // resolve to a known language via matchLanguage.
  let splitAt = -1
  for (let i = rest.length - 1; i >= 0; i--) {
    const word = rest[i]
    if (word !== undefined && isInWord(word)) {
      splitAt = i
      break
    }
  }
  if (splitAt !== -1 && splitAt !== 0 && splitAt !== rest.length - 1) {
    const text = rest.slice(0, splitAt).join(' ')
    const langQuery = rest.slice(splitAt + 1).join(' ')
    const target = matchLanguage(langQuery)
    if (target) return { text, target }
  }

  if (hasPrefix) {
    const text = rest.join(' ')
    if (text !== '' && defaultTarget) return { text, target: defaultTarget }
  }

  return undefined
}
