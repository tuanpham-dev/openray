import { LANGUAGES, parseIntent, translate } from '@openray/translate-core'
import { getTranslateSettings } from '@openray/extras'
import { listTranslateCommands, recordHistory } from './storage'
import { TranslateBody } from './TranslateBody'

function languageName(code: string): string {
  if (code === 'auto') return 'Detect Language'
  return LANGUAGES.find((lang) => lang.code === code)?.name ?? code.toUpperCase()
}

export default async function listRootCommands() {
  const pairs = await listTranslateCommands()
  return pairs.map((pair) => ({
    id: pair.id,
    title: pair.title,
    subtitle: `${languageName(pair.sourceLang)} → ${languageName(pair.targetLang)}`,
    // Every row here always opens a view (the preset language pair) —
    // there's no headless activation for a translate pair, matching
    // native `TranslateProvider::execute`'s own "every id opens a view"
    // contract.
    opensView: true,
  }))
}

/** Never actually reached: every row's `opensView: true` routes activation
 * to `view` below instead (`extension_commands::launch_root_command`,
 * T20/T21). Left as a no-op rather than omitted, matching this codebase's
 * established convention for a headless export that a routing change
 * could otherwise silently bypass into. */
export async function execute(): Promise<void> {}

interface OnQueryContext {
  aliases: Record<string, string>
}

/** T21 inline row: parses `query` for a trailing `in|into <language>` or
 * a leading `translate <text>`/`<alias> <text>`, and — only if one
 * resolves — runs the real translation before returning the row (see
 * T21's plan notes for why this, not a provisional-then-updated row, is
 * the deliberate design here: the protocol supports an arbitrarily slow
 * single reply, just not a later push for the same query). Records
 * history on success, same as native's inline flow (both `detect_intent`
 * and the full view route through the same `translate_text`/history
 * path). */
export async function onQuery(query: string, context: OnQueryContext) {
  const settings = await getTranslateSettings()
  const defaultTarget = LANGUAGES.find((lang) => lang.code === settings.targetLanguage)
  const alias = context.aliases.translate
  const intent = parseIntent(query, defaultTarget, alias)
  if (!intent) return null

  try {
    const result = await translate(intent.text, 'auto', intent.target.code)
    await recordHistory(intent.text, result.translatedText, result.detectedSource, intent.target.code, settings.historyEnabled)
    return {
      id: 'inline-translation',
      title: result.translatedText,
      subtitle: `Translate to ${intent.target.name}`,
      value: result.translatedText,
      display: 'card',
      sectionLabel: `Translate to ${intent.target.name}`,
      cardLeft: intent.text,
    }
  } catch {
    // A failed inline translation (rate-limited/network/parse) just
    // contributes nothing rather than showing an error row — the query
    // is additive to normal search results either way (module doc
    // comment), and the full Translate view surfaces the real error
    // banner for anyone who opens it directly.
    return null
  }
}

interface ViewProps {
  id: string
}

/** Mounted for a custom pair's row (`opensView: true` above) — `id` is
 * the pair's own opaque row id, looked up by `TranslateBody` itself. */
export function view({ id }: ViewProps) {
  return <TranslateBody presetId={id} />
}
