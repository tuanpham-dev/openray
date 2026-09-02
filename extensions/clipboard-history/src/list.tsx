import { useEffect, useMemo, useState } from 'react'
import { Action, ActionPanel, Icon, List, confirmAlert, open, showHUD } from '@raycast/api'
import {
  type ClipboardHistoryEntry,
  clearClipboardHistory,
  deleteClipboardHistoryEntry,
  listClipboardHistory,
  pasteClipboardHistoryEntry,
  pasteImageClipboardHistoryEntry,
} from '@openray/extras'
import { detectContentKind, parseColor, toHex, toRgbString, urlHost, type ClipboardContentKind, type Rgb } from './contentType'

/** Images and files are storage kinds the backend already records; the
 *  rest are detected from the entry's own text — the same split native
 *  x-ray's clipboard view used before this was an extension. */
type EntryKind = ClipboardContentKind | 'image' | 'file'
type Filter = EntryKind | 'all'

const KIND_LABELS: Record<EntryKind, string> = {
  color: 'Color',
  url: 'Link',
  email: 'Email',
  number: 'Number',
  text: 'Text',
  image: 'Image',
  file: 'File',
}

const KIND_ICONS: Record<EntryKind, string> = {
  color: 'clipboard',
  url: 'link',
  email: 'mail',
  number: 'hash',
  text: 'text',
  image: 'camera',
  file: 'file',
}

const FILTERS: { value: Filter; title: string }[] = [
  { value: 'all', title: 'All Types' },
  { value: 'text', title: 'Text' },
  { value: 'image', title: 'Images' },
  { value: 'file', title: 'Files' },
  { value: 'url', title: 'Links' },
  { value: 'color', title: 'Colors' },
  { value: 'email', title: 'Emails' },
  { value: 'number', title: 'Numbers' },
]

/**
 * Which dated section an entry belongs under.
 *
 * Boundaries are *calendar* ones, not rolling 24-hour windows: something
 * copied at 11pm last night reads as "Yesterday" the next morning, not as
 * "Today" for another hour. `startOfDay` is recomputed per call rather than
 * cached, so a list left open across midnight regroups correctly on its next
 * render instead of insisting it is still the previous day.
 */
const PERIODS = ['Today', 'Yesterday', 'This Week', 'This Month', 'Older'] as const
type Period = (typeof PERIODS)[number]

function entryPeriod(entry: ClipboardHistoryEntry, now: Date): Period {
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const copied = entry.createdAt * 1000
  const day = 86_400_000

  if (copied >= startOfDay) return 'Today'
  if (copied >= startOfDay - day) return 'Yesterday'
  // "This Week" counts back seven days rather than to a locale's week start:
  // the point is recency, and a Monday boundary would leave Sunday's copies
  // stranded under "This Month" the moment the week ticks over.
  if (copied >= startOfDay - 7 * day) return 'This Week'
  if (copied >= startOfDay - 30 * day) return 'This Month'
  return 'Older'
}

function entryKind(entry: ClipboardHistoryEntry): EntryKind {
  if (entry.kind === 'image' || entry.kind === 'file') return entry.kind
  return detectContentKind(entry.text)
}

function entryColor(entry: ClipboardHistoryEntry, kind: EntryKind): Rgb | null {
  return kind === 'color' ? parseColor(entry.text) : null
}

function formatBytes(bytes: number | null): string | undefined {
  if (bytes == null) return undefined
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Trailing path segment, so a file reads by name in the list and keeps its
 *  full path for the detail pane. */
function baseName(path: string): string {
  return path.trim().split('/').filter(Boolean).pop() ?? path
}

function imageLabel(entry: ClipboardHistoryEntry): string {
  const { imageWidth: w, imageHeight: h } = entry
  return w && h ? `Image (${w}×${h})` : 'Image'
}

function previewTitle(entry: ClipboardHistoryEntry, kind: EntryKind): string {
  if (kind === 'image') return imageLabel(entry)
  if (kind === 'file') return baseName(entry.text)
  return entry.text.split('\n')[0]?.slice(0, 200) || '(empty)'
}

/** A row's leading visual: the thumbnail for an image, the colour itself
 *  for a colour (the host renders a bare `#rrggbb` as a swatch), and the
 *  kind's own glyph otherwise. */
function rowIcon(entry: ClipboardHistoryEntry, kind: EntryKind, color: Rgb | null): string | undefined {
  if (kind === 'image') return entry.imagePath ?? KIND_ICONS.image
  if (color) return toHex(color)
  return KIND_ICONS[kind]
}

function rowSubtitle(entry: ClipboardHistoryEntry, kind: EntryKind): string | undefined {
  if (kind === 'file') return entry.text.trim()
  if (kind === 'url') return urlHost(entry.text) ?? undefined
  return undefined
}

/** Fences the raw text so the detail pane shows it verbatim — clipboard
 *  content is not markdown, and rendering it as markdown ate list markers,
 *  headings and underscores. The fence grows past any backtick run inside
 *  the text so content that itself contains a fence can't break out. */
function codeBlock(text: string): string {
  const longestRun = [...text.matchAll(/`+/g)].reduce((max, [run]) => Math.max(max, run.length), 0)
  const fence = '`'.repeat(Math.max(3, longestRun + 1))
  return `${fence}\n${text}\n${fence}`
}

function detailMarkdown(entry: ClipboardHistoryEntry, kind: EntryKind): string {
  if (kind === 'image') return entry.imagePath ? `![](${entry.imagePath})` : '_No preview available._'
  if (kind === 'file') return `### ${baseName(entry.text)}\n\n${codeBlock(entry.text.trim())}`
  if (!entry.text) return '_(empty)_'
  return codeBlock(entry.text)
}

/** The Information block under the preview: the rows unique to this kind
 *  first, then Type and Copied, which every entry carries. */
function DetailMetadata({ entry, kind, color }: { entry: ClipboardHistoryEntry; kind: EntryKind; color: Rgb | null }) {
  const host = kind === 'url' ? urlHost(entry.text) : null

  return (
    <List.Item.Detail.Metadata>
      {kind === 'image' && (
        <>
          <List.Item.Detail.Metadata.Label title="Content Type" text="Image (PNG)" />
          {entry.imageWidth != null && entry.imageHeight != null && (
            <List.Item.Detail.Metadata.Label title="Dimensions" text={`${entry.imageWidth} × ${entry.imageHeight}`} />
          )}
          {entry.imageBytes != null && <List.Item.Detail.Metadata.Label title="File Size" text={formatBytes(entry.imageBytes)} />}
          {entry.imagePath && <List.Item.Detail.Metadata.Label title="Path" text={entry.imagePath} />}
        </>
      )}
      {color && (
        <>
          <List.Item.Detail.Metadata.Label title="Color" text={toHex(color)} icon={toHex(color)} />
          <List.Item.Detail.Metadata.Label title="RGB" text={toRgbString(color)} />
        </>
      )}
      {kind === 'file' && (
        <>
          <List.Item.Detail.Metadata.Label title="Content Type" text="File" />
          <List.Item.Detail.Metadata.Label title="Path" text={entry.text.trim()} />
        </>
      )}
      {/* Host only: the URL itself is already the preview above, and a
          second full copy of a long one wrapped over four lines here. */}
      {kind === 'url' && host && <List.Item.Detail.Metadata.Label title="Host" text={host} />}
      {kind === 'email' && <List.Item.Detail.Metadata.Label title="Address" text={entry.text.trim()} />}
      {(kind === 'text' || kind === 'number') && (
        <>
          <List.Item.Detail.Metadata.Label title="Characters" text={entry.text.length.toLocaleString()} />
          <List.Item.Detail.Metadata.Label title="Words" text={String(entry.text.trim().split(/\s+/).filter(Boolean).length)} />
        </>
      )}
      <List.Item.Detail.Metadata.Separator />
      <List.Item.Detail.Metadata.Label title="Type" text={KIND_LABELS[kind]} />
      <List.Item.Detail.Metadata.Label title="Copied" text={new Date(entry.createdAt * 1000).toLocaleString()} />
    </List.Item.Detail.Metadata>
  )
}

export default function ClipboardHistoryCommand() {
  const [entries, setEntries] = useState<ClipboardHistoryEntry[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [filter, setFilter] = useState<Filter>('all')

  const refresh = async () => {
    setIsLoading(true)
    setEntries(await listClipboardHistory())
    setIsLoading(false)
  }

  useEffect(() => {
    void refresh()
  }, [])

  const filtered = filter === 'all' ? entries : entries.filter((entry) => entryKind(entry) === filter)

  // Grouped for display only — `filtered` stays the flat, already-sorted list
  // the backend returned, so ordering within a section is untouched and an
  // empty period simply never renders a header.
  const grouped = useMemo(() => {
    const now = new Date()
    const buckets = new Map<Period, ClipboardHistoryEntry[]>()
    for (const entry of filtered) {
      const period = entryPeriod(entry, now)
      const bucket = buckets.get(period)
      if (bucket) bucket.push(entry)
      else buckets.set(period, [entry])
    }
    return PERIODS.map((period) => ({ period, entries: buckets.get(period) ?? [] })).filter((g) => g.entries.length > 0)
  }, [filtered])

  const paste = async (entry: ClipboardHistoryEntry) => {
    if (entry.kind === 'image') await pasteImageClipboardHistoryEntry(entry.id)
    else await pasteClipboardHistoryEntry(entry.id)
  }

  const remove = async (entry: ClipboardHistoryEntry) => {
    const confirmed = await confirmAlert({ title: 'Delete this entry?', message: 'This cannot be undone.' })
    if (!confirmed) return
    await deleteClipboardHistoryEntry(entry.id)
    await showHUD('Deleted')
    await refresh()
  }

  const clearAll = async () => {
    const confirmed = await confirmAlert({ title: 'Clear all clipboard history?', message: 'This cannot be undone.' })
    if (!confirmed) return
    await clearClipboardHistory()
    await showHUD('Clipboard History Cleared')
    await refresh()
  }

  const renderEntry = (entry: ClipboardHistoryEntry) => {
    const kind = entryKind(entry)
    const color = entryColor(entry, kind)
    const value = entry.text.trim()
    return (
      <List.Item
        key={entry.id}
        id={entry.id}
        title={previewTitle(entry, kind)}
        subtitle={rowSubtitle(entry, kind)}
        icon={rowIcon(entry, kind, color)}
        detail={<List.Item.Detail markdown={detailMarkdown(entry, kind)} metadata={<DetailMetadata entry={entry} kind={kind} color={color} />} />}
        actions={
          <ActionPanel>
            <Action title="Paste" icon="clipboard" onAction={() => void paste(entry)} />
            {entry.kind !== 'image' && (
              <Action.CopyToClipboard title="Copy" content={entry.text} shortcut={{ modifiers: ['cmd'], key: 'c' }} />
            )}
            {/* Type-specific entries, the way native's preview offered
                them — a link opens, a file opens, a colour copies in
                either notation. */}
            {kind === 'url' && <Action.OpenInBrowser title="Open in Browser" url={value} />}
            {kind === 'file' && <Action title="Open File" icon="file" onAction={() => void open(value)} />}
            {kind === 'email' && <Action title="Compose Email" icon="mail" onAction={() => void open(`mailto:${value}`)} />}
            {color && (
              <>
                <Action.CopyToClipboard title="Copy as HEX" content={toHex(color)} />
                <Action.CopyToClipboard title="Copy as RGB" content={toRgbString(color)} />
              </>
            )}
            <Action
              title="Delete"
              icon={Icon.Trash}
              style="destructive"
              shortcut={{ modifiers: ['cmd'], key: 'backspace' }}
              onAction={() => void remove(entry)}
            />
            <ActionPanel.Section>
              <Action
                title="Clear All"
                icon={Icon.Trash}
                style="destructive"
                shortcut={{ modifiers: ['cmd', 'shift'], key: 'backspace' }}
                onAction={() => void clearAll()}
              />
            </ActionPanel.Section>
          </ActionPanel>
        }
      />
        )
  }

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Search clipboard history…"
      navigationTitle="Clipboard History"
      searchBarAccessory={
        <List.Dropdown tooltip="Filter by type" value={filter} onChange={(value) => setFilter(value as Filter)}>
          {FILTERS.map((option) => (
            <List.Dropdown.Item key={option.value} title={option.title} value={option.value} />
          ))}
        </List.Dropdown>
      }
    >
      <List.EmptyView title="No Clipboard History" description="Copy something to see it here." />
      {grouped.map(({ period, entries: inPeriod }) => (
        <List.Section key={period} title={period}>
          {inPeriod.map(renderEntry)}
        </List.Section>
      ))}
    </List>
  )
}
