import { useEffect, useState } from 'react'
import { Action, ActionPanel, List, confirmAlert, showHUD } from '@raycast/api'
import {
  type ClipboardHistoryEntry,
  clearClipboardHistory,
  deleteClipboardHistoryEntry,
  listClipboardHistory,
  pasteClipboardHistoryEntry,
  pasteImageClipboardHistoryEntry,
} from '@openray/extras'

type Filter = 'all' | 'text' | 'file' | 'image'

function formatBytes(bytes: number | null): string | undefined {
  if (bytes == null) return undefined
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function previewTitle(entry: ClipboardHistoryEntry): string {
  if (entry.kind === 'image') return `Image (${entry.imageWidth ?? '?'}×${entry.imageHeight ?? '?'})`
  return entry.text.split('\n')[0]?.slice(0, 200) || '(empty)'
}

// Native's own preview sniffed text further into colors/links/emails/numbers
// for richer per-kind actions — this port keeps the three real backend
// `kind`s (text/file/image) as the whole filter/preview surface, a
// disclosed simplification.
function detailMarkdown(entry: ClipboardHistoryEntry): string {
  if (entry.kind === 'image') return entry.imagePath ? `![](${entry.imagePath})` : '_No preview available._'
  if (entry.kind === 'file') return `**File**\n\n\`${entry.text}\``
  return entry.text || '_(empty)_'
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

  const filtered = filter === 'all' ? entries : entries.filter((entry) => entry.kind === filter)

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

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Search clipboard history…"
      navigationTitle="Clipboard History"
      searchBarAccessory={
        <List.Dropdown tooltip="Filter by type" value={filter} onChange={(value) => setFilter(value as Filter)}>
          <List.Dropdown.Item title="All" value="all" />
          <List.Dropdown.Item title="Text" value="text" />
          <List.Dropdown.Item title="Files" value="file" />
          <List.Dropdown.Item title="Images" value="image" />
        </List.Dropdown>
      }
    >
      <List.EmptyView title="No Clipboard History" description="Copy something to see it here." />
      {filtered.map((entry) => (
        <List.Item
          key={entry.id}
          id={entry.id}
          title={previewTitle(entry)}
          subtitle={entry.kind === 'file' ? 'File' : undefined}
          icon={entry.kind === 'image' ? (entry.imagePath ?? undefined) : undefined}
          accessories={[{ date: new Date(entry.createdAt * 1000).toISOString() }]}
          detail={
            <List.Item.Detail
              markdown={detailMarkdown(entry)}
              metadata={
                <List.Item.Detail.Metadata>
                  <List.Item.Detail.Metadata.Label title="Type" text={entry.kind[0].toUpperCase() + entry.kind.slice(1)} />
                  {entry.kind === 'image' && entry.imageWidth != null && entry.imageHeight != null && (
                    <List.Item.Detail.Metadata.Label title="Dimensions" text={`${entry.imageWidth} × ${entry.imageHeight}`} />
                  )}
                  {entry.imageBytes != null && <List.Item.Detail.Metadata.Label title="File Size" text={formatBytes(entry.imageBytes)} />}
                  {entry.kind === 'file' && <List.Item.Detail.Metadata.Label title="Path" text={entry.text} />}
                  <List.Item.Detail.Metadata.Label title="Copied" text={new Date(entry.createdAt * 1000).toLocaleString()} />
                </List.Item.Detail.Metadata>
              }
            />
          }
          actions={
            <ActionPanel>
              <Action title="Paste" onAction={() => void paste(entry)} />
              {entry.kind !== 'image' && (
                <Action.CopyToClipboard title="Copy" content={entry.text} shortcut={{ modifiers: ['cmd'], key: 'c' }} />
              )}
              <Action title="Delete" style="destructive" shortcut={{ modifiers: ['cmd'], key: 'backspace' }} onAction={() => void remove(entry)} />
              <ActionPanel.Section>
                <Action
                  title="Clear All"
                  style="destructive"
                  shortcut={{ modifiers: ['cmd', 'shift'], key: 'backspace' }}
                  onAction={() => void clearAll()}
                />
              </ActionPanel.Section>
            </ActionPanel>
          }
        />
      ))}
    </List>
  )
}
