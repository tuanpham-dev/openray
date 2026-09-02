import { useEffect, useMemo, useState } from 'react'
import { Action, ActionPanel, Grid, Icon } from '@raycast/api'
import {
  copyScreenshotWithFormat,
  dropScreenshot,
  getScreenshotsSettings,
  openScreenshot,
  pasteScreenshotWithFormat,
  queryScreenshots,
  screenshotDropSupported,
  setScreenshotPinned,
  type ScreenshotEntry,
  type ScreenshotPasteFormat,
  type ScreenshotsSettings,
} from '@openray/extras'

const FORMAT_LABELS: Record<ScreenshotPasteFormat, string> = { auto: 'Auto', image: 'Image', file: 'File', path: 'Path' }

/** Which formats make sense for a file of this kind — `image` requires
 *  decoding pixel data so it's image-only; `file`/`path`/`auto` work for
 *  videos too since no image decode is involved. */
function availableFormats(kind: ScreenshotEntry['kind']): ScreenshotPasteFormat[] {
  return kind === 'image' ? ['auto', 'image', 'file', 'path'] : ['auto', 'file', 'path']
}

/** The configured default, unless that's `image` and the entry is a video
 *  (no pixel data to decode) — falls back to `file` rather than silently
 *  doing nothing. */
function effectiveFormat(kind: ScreenshotEntry['kind'], configured: ScreenshotPasteFormat): ScreenshotPasteFormat {
  return kind === 'video' && configured === 'image' ? 'file' : configured
}

function dateKey(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function resolveDateToken(token: string): string | null {
  if (token === 'today') return dateKey(Date.now() / 1000)
  if (token === 'yesterday') return dateKey(Date.now() / 1000 - 86400)
  return /^\d{4}-\d{2}-\d{2}$/.test(token) ? token : null
}

interface ParsedQuery {
  name: string | null
  text: string | null
  date: string | null
  bare: string | null
}

/** Raycast-style search prefixes: `name:`/`text:`/`date:` restrict which
 *  field is matched; anything else is a bare term matched against name OR
 *  OCR text. `date:` accepts `today`, `yesterday`, or `YYYY-MM-DD`. */
function parseQuery(raw: string): ParsedQuery {
  const tokens = raw.trim().split(/\s+/).filter(Boolean)
  let name: string | null = null
  let text: string | null = null
  let date: string | null = null
  const bareTokens: string[] = []
  for (const token of tokens) {
    const lower = token.toLowerCase()
    if (lower.startsWith('name:')) name = token.slice(5)
    else if (lower.startsWith('text:')) text = token.slice(5)
    else if (lower.startsWith('date:')) date = resolveDateToken(token.slice(5))
    else bareTokens.push(token)
  }
  return { name, text, date, bare: bareTokens.length > 0 ? bareTokens.join(' ') : null }
}

function matchesEntry(entry: ScreenshotEntry, parsed: ParsedQuery, ocrEnabled: boolean): boolean {
  const ocrText = ocrEnabled ? (entry.ocrText ?? '') : ''
  if (parsed.date && dateKey(entry.createdAt) !== parsed.date) return false
  if (parsed.name && !entry.name.toLowerCase().includes(parsed.name.toLowerCase())) return false
  if (parsed.text && !ocrText.toLowerCase().includes(parsed.text.toLowerCase())) return false
  if (parsed.bare) {
    const needle = parsed.bare.toLowerCase()
    if (!entry.name.toLowerCase().includes(needle) && !ocrText.toLowerCase().includes(needle)) return false
  }
  return true
}

type KindFilter = 'all' | 'image' | 'video'

/** The grid view (T29's `opensView: true` root-provider row). Windowed
 *  rendering for 1k+ items is the host renderer's job now
 *  (`TreeRenderer.tsx`'s `useVirtualizedGrid`), not this component's —
 *  the port from native `ScreenshotsView.tsx` moved that concern into
 *  the shared `Grid` primitive so any extension gets it for free. */
export function ScreenshotsGrid() {
  const [entries, setEntries] = useState<ScreenshotEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [settings, setSettings] = useState<ScreenshotsSettings | null>(null)
  const [dropSupported, setDropSupported] = useState(false)
  const [query, setQuery] = useState('')
  const [kindFilter, setKindFilter] = useState<KindFilter>('all')

  useEffect(() => {
    void getScreenshotsSettings().then(setSettings)
    void screenshotDropSupported().then(setDropSupported)
    void queryScreenshots().then((next) => {
      setEntries(next)
      setLoading(false)
    })
  }, [])

  const parsed = useMemo(() => parseQuery(query), [query])
  const ocrEnabled = settings?.ocrEnabled ?? false
  const filtered = useMemo(
    () => entries.filter((entry) => (kindFilter === 'all' || entry.kind === kindFilter) && matchesEntry(entry, parsed, ocrEnabled)),
    [entries, parsed, kindFilter, ocrEnabled],
  )

  const defaultFormat = settings?.pasteFormat ?? 'auto'

  const togglePinned = (path: string, pinned: boolean) => {
    setEntries((current) => current.map((entry) => (entry.path === path ? { ...entry, pinned } : entry)))
    void setScreenshotPinned(path, pinned)
  }

  return (
    <Grid
      isLoading={loading}
      columns={settings?.gridColumns || 4}
      searchText={query}
      onSearchTextChange={setQuery}
      searchBarPlaceholder="Search screenshots…"
      navigationTitle="Search Screenshots"
      searchBarAccessory={
        <Grid.Dropdown tooltip="Filter by type" value={kindFilter} onChange={(value) => setKindFilter(value as KindFilter)}>
          <Grid.Dropdown.Item title="All" value="all" />
          <Grid.Dropdown.Item title="Images" value="image" />
          <Grid.Dropdown.Item title="Videos" value="video" />
        </Grid.Dropdown>
      }
    >
      <Grid.EmptyView title={entries.length === 0 ? 'No Screenshots Found' : 'No Matching Screenshots'} />
      {filtered.map((entry) => {
        const format = effectiveFormat(entry.kind, defaultFormat)
        return (
          <Grid.Item
            key={entry.path}
            id={entry.path}
            content={entry.kind === 'image' ? entry.path : (entry.thumbnailPath ?? '🎬')}
            title={entry.name}
            actions={
              <ActionPanel>
                <Action title="Paste" icon={Icon.Clipboard} onAction={() => void pasteScreenshotWithFormat(entry.path, format)} />
                <Action title={`Copy as ${FORMAT_LABELS[format]}`} icon="copy" onAction={() => void copyScreenshotWithFormat(entry.path, format)} />
                {availableFormats(entry.kind)
                  .filter((alt) => alt !== format)
                  .map((alt) => (
                    <Action
                      key={`copy-as-${alt}`}
                      title={`Copy as ${FORMAT_LABELS[alt]}`}
                      icon="copy"
                      onAction={() => void copyScreenshotWithFormat(entry.path, alt)}
                    />
                  ))}
                {dropSupported && <Action title="Drop at Cursor" icon="crosshair" onAction={() => void dropScreenshot(entry.path)} />}
                <Action title="Open" icon={Icon.ExternalLink} onAction={() => void openScreenshot(entry.path)} />
                <Action
                  title={entry.pinned ? 'Unpin' : 'Pin'}
                  icon={Icon.Pin}
                  onAction={() => togglePinned(entry.path, !entry.pinned)}
                />
              </ActionPanel>
            }
          />
        )
      })}
    </Grid>
  )
}
