import { getHostBridge } from '../bridge'

/** A row from the native `clipboard_history` table — the watcher stays
 * platform (`infrastructure/clipboard_watcher.rs`); this extension only
 * ever reads/mutates it through the bridge. `kind === 'image'`'s `text` is
 * empty; `kind === 'file'`'s `text` holds the file's path. */
export interface ClipboardHistoryEntry {
  id: string
  text: string
  createdAt: number
  kind: 'text' | 'file' | 'image'
  imagePath: string | null
  imageWidth: number | null
  imageHeight: number | null
  imageBytes: number | null
}

export async function listClipboardHistory(): Promise<ClipboardHistoryEntry[]> {
  return ((await getHostBridge().call('host.clipboardHistory.list')) ?? []) as ClipboardHistoryEntry[]
}

export async function getClipboardHistoryEntry(id: string): Promise<ClipboardHistoryEntry | null> {
  return ((await getHostBridge().call('host.clipboardHistory.get', { id })) ?? null) as ClipboardHistoryEntry | null
}

export async function deleteClipboardHistoryEntry(id: string): Promise<void> {
  await getHostBridge().call('host.clipboardHistory.delete', { id })
}

export async function clearClipboardHistory(): Promise<void> {
  await getHostBridge().call('host.clipboardHistory.clearAll')
}

/** Hides the palette, then types `id`'s text directly into whatever window
 * regains focus — `text` and `file` entries (a file entry's "text" is its
 * path). Image entries need `pasteImageClipboardHistoryEntry` instead. */
export async function pasteClipboardHistoryEntry(id: string): Promise<void> {
  await getHostBridge().call('host.clipboardHistory.paste', { id })
}

/** Same hide-then-paste flow as `pasteClipboardHistoryEntry`, but for an
 * image entry: puts the decoded image on the system clipboard and replays
 * the paste keystroke, since there's no text to type. */
export async function pasteImageClipboardHistoryEntry(id: string): Promise<void> {
  await getHostBridge().call('host.clipboardHistory.pasteImage', { id })
}
