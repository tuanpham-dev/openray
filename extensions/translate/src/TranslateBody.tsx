import { useEffect, useState } from 'react'
import { Action, ActionPanel, List } from '@raycast/api'
import { LANGUAGES, translate, type Translation } from '@openray/translate-core'
import { getTranslateSettings, setTranslateTargetLanguage } from '@openray/extras'
import { getTranslateCommand, listHistory, recordHistory, type HistoryEntry } from './storage'
import { LanguagePicker } from './LanguagePicker'

const TRANSLATE_DEBOUNCE_MS = 300

interface TranslateBodyProps {
  /** Opens with a custom pair's fixed language pair instead of the
   *  app-wide defaults. */
  presetId?: string
}

function languageName(code: string): string {
  if (code === 'auto') return 'Detect Language'
  return LANGUAGES.find((lang) => lang.code === code)?.name ?? code.toUpperCase()
}

/** The shared body for both the static "Translate" command and a mounted
 * custom-pair row (`list.tsx`'s `view` export) — ported behavior, not
 * pixel layout, from native `TranslateView.tsx`: no `@raycast/api`
 * primitive expresses a live two-pane split editor, so the search bar
 * doubles as the source-text input (a common real Raycast-extension
 * convention for this shape) and the translated result renders as the
 * single matching `List.Item`. Two disclosed, deliberate simplifications
 * from native, both stemming from the same host constraint — this
 * renderer's `List` has no controlled/re-seedable search text (confirmed
 * by reading `TreeRenderer.tsx`'s `ExtensionList` before assuming
 * otherwise): "Swap Languages" swaps the language selection only, it
 * doesn't reload the translated text back into the source box; and the
 * T21 inline row's activation is Enter-to-copy only, with no ⌘↵
 * hand-off into this view carrying prefilled text (T21's `InlineRow`
 * contract has no slot for that).
 */
export function TranslateBody({ presetId }: TranslateBodyProps) {
  const [sourceLang, setSourceLang] = useState('auto')
  const [targetLang, setTargetLangState] = useState('en')
  const [ready, setReady] = useState(false)
  const [historyEnabled, setHistoryEnabled] = useState(true)
  const [primaryAction, setPrimaryAction] = useState<'copy' | 'paste'>('copy')

  const [searchText, setSearchText] = useState('')
  const [result, setResult] = useState<Translation | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const [history, setHistory] = useState<HistoryEntry[]>([])

  useEffect(() => {
    void (async () => {
      if (presetId) {
        const preset = await getTranslateCommand(presetId)
        if (preset) {
          setSourceLang(preset.sourceLang)
          setTargetLangState(preset.targetLang)
        }
      }
      const settings = await getTranslateSettings()
      if (!presetId) {
        setSourceLang(settings.sourceLanguage)
        setTargetLangState(settings.targetLanguage)
      }
      setHistoryEnabled(settings.historyEnabled)
      setPrimaryAction(settings.primaryAction)
      setReady(true)
    })()
  }, [presetId])

  useEffect(() => {
    if (!ready) return
    if (searchText.trim() === '') {
      setResult(null)
      setFailed(null)
      setIsLoading(false)
      void listHistory().then(setHistory)
      return
    }

    setIsLoading(true)
    let cancelled = false
    const timer = setTimeout(() => {
      void translate(searchText, sourceLang, targetLang)
        .then(async (translation) => {
          if (cancelled) return
          setResult(translation)
          setFailed(null)
          await recordHistory(searchText, translation.translatedText, translation.detectedSource, targetLang, historyEnabled)
        })
        .catch((err: unknown) => {
          if (cancelled) return
          setFailed(err instanceof Error ? err.message : String(err))
          setResult(null)
        })
        .finally(() => {
          if (!cancelled) setIsLoading(false)
        })
    }, TRANSLATE_DEBOUNCE_MS)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [searchText, sourceLang, targetLang, ready, historyEnabled])

  const setTargetLang = (code: string) => {
    setTargetLangState(code)
    // Only the app-wide default is remembered across sessions, matching
    // native — a preset pair's own languages aren't meant to drift with
    // whatever the user last picked elsewhere.
    if (!presetId) void setTranslateTargetLanguage(code)
  }

  const swap = () => {
    if (!result) return
    const newSource = targetLang
    const newTarget = sourceLang === 'auto' ? (result.detectedSource ?? targetLang) : sourceLang
    setSourceLang(newSource)
    setTargetLang(newTarget)
  }

  if (!ready) return <List isLoading searchBarPlaceholder="Enter text to translate…" />

  const errorMessage = failed
    ? failed.startsWith('rate_limited:')
      ? 'Translation service is rate-limiting requests. Try again shortly.'
      : failed.startsWith('network:')
        ? "Couldn't reach the translation service. Check your connection."
        : 'Translation failed.'
    : null

  const languagePickerActions = (
    <>
      <Action.Push title="Change Source Language" target={<LanguagePicker includeAuto onSelect={setSourceLang} />} />
      <Action.Push title="Change Target Language" target={<LanguagePicker onSelect={setTargetLang} />} />
    </>
  )

  return (
    <List
      isLoading={isLoading}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder="Enter text to translate…"
      navigationTitle={`Translate: ${languageName(sourceLang)} → ${languageName(targetLang)}`}
    >
      {searchText.trim() === '' ? (
        <List.EmptyView title="Recent translations appear here" actions={<ActionPanel>{languagePickerActions}</ActionPanel>} />
      ) : errorMessage ? (
        <List.EmptyView title={errorMessage} actions={<ActionPanel>{languagePickerActions}</ActionPanel>} />
      ) : (
        <List.Item
          id="result"
          title={isLoading || !result ? 'Translating…' : result.translatedText}
          subtitle={result?.detectedSource ? `Detected: ${languageName(result.detectedSource)}` : undefined}
          actions={
            <ActionPanel>
              {result && (
                <>
                  {primaryAction === 'paste' ? (
                    <>
                      <Action.Paste title="Paste Translation" content={result.translatedText} />
                      <Action.CopyToClipboard title="Copy Translation" content={result.translatedText} />
                    </>
                  ) : (
                    <>
                      <Action.CopyToClipboard title="Copy Translation" content={result.translatedText} />
                      <Action.Paste title="Paste Translation" content={result.translatedText} />
                    </>
                  )}
                  <Action.CopyToClipboard title="Copy Source Text" content={searchText} />
                  <Action title="Swap Languages" onAction={swap} />
                </>
              )}
              {languagePickerActions}
            </ActionPanel>
          }
        />
      )}
      {searchText.trim() === '' &&
        history.slice(0, 20).map((entry) => (
          <List.Item
            key={entry.id}
            id={entry.id}
            title={entry.sourceText}
            subtitle={`${languageName(entry.targetLang)} · ${entry.translatedText}`}
            actions={
              <ActionPanel>
                <Action.CopyToClipboard title="Copy Translation" content={entry.translatedText} />
                <Action.CopyToClipboard title="Copy Source Text" content={entry.sourceText} />
                {languagePickerActions}
              </ActionPanel>
            }
          />
        ))}
    </List>
  )
}
