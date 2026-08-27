import { deriveTitle } from './title'

/** The extension-storage record shape — `id` is the note's `sync_id`
 *  string (see the T26 migration's own doc comment for why the local
 *  SQLite integer id can't survive the move to a cross-device key). */
export interface NoteRecord {
  id: string
  content: string
  pinnedAt: number | null
  createdAt: number
  updatedAt: number
  lastOpenedAt: number
}

export interface Note extends NoteRecord {
  title: string
}

export function toNote(record: NoteRecord): Note {
  return { ...record, title: deriveTitle(record.content) }
}

/**
 * Port of `application::notes::select_all`'s ordering — pinned notes first
 * (oldest-pinned first, giving a stable ⌘0–9 order), then the rest by
 * most-recently-opened.
 */
export function sortNotes(notes: Note[]): Note[] {
  return [...notes].sort((a, b) => {
    const aPinned = a.pinnedAt !== null
    const bPinned = b.pinnedAt !== null
    if (aPinned !== bPinned) return aPinned ? -1 : 1
    if (aPinned && bPinned) return (a.pinnedAt as number) - (b.pinnedAt as number)
    return b.lastOpenedAt - a.lastOpenedAt
  })
}

/**
 * Port of `application::notes::search_rows` — case-folded substring match
 * over the derived title and the raw content (not SQL `LIKE`, which is
 * ASCII-only case-insensitive; `toLowerCase()` is Unicode-aware).
 */
export function searchNotes(notes: Note[], query: string): Note[] {
  const needle = query.trim().toLowerCase()
  const sorted = sortNotes(notes)
  if (!needle) return sorted
  return sorted.filter((note) => note.title.toLowerCase().includes(needle) || note.content.toLowerCase().includes(needle))
}
