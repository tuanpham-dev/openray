import { LocalStorage } from '@raycast/api'
import { toNote, type Note, type NoteRecord } from '@openray/notes-core'

/** One `LocalStorage` bucket, `note:{syncId}` keys — matches the shape
 * migration `0025_notes_to_extension_storage.sql` writes into
 * `extension_storage` for pre-existing rows exactly (see that migration's
 * own doc comment for why the key is the note's `sync_id`, not a local
 * integer id: it's what preserves cross-device merge continuity). */
const NOTE_PREFIX = 'note:'

function newNoteId(): string {
  // Matches the shape (not the exact algorithm) of the native table's own
  // `lower(hex(randomblob(16)))` sync_id closely enough — 32 lowercase hex
  // characters — without needing a real CSPRNG dependency for an opaque
  // local id; nothing compares this against the native format directly.
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function parseRecord(key: string, raw: string): NoteRecord | undefined {
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) return undefined
    const record = value as Record<string, unknown>
    if (typeof record.content !== 'string') return undefined
    return {
      id: typeof record.id === 'string' ? record.id : key.slice(NOTE_PREFIX.length),
      content: record.content,
      pinnedAt: typeof record.pinnedAt === 'number' ? record.pinnedAt : null,
      createdAt: typeof record.createdAt === 'number' ? record.createdAt : 0,
      updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0,
      lastOpenedAt: typeof record.lastOpenedAt === 'number' ? record.lastOpenedAt : 0,
    }
  } catch {
    return undefined
  }
}

async function writeRecord(record: NoteRecord): Promise<void> {
  await LocalStorage.setItem(`${NOTE_PREFIX}${record.id}`, JSON.stringify(record))
}

/** Strips `title` before writing — `Note` is `NoteRecord` plus a `title`
 *  *derived* from `content` on every read (`toNote`), never a stored
 *  column (matches `application::notes`'s own "title is never stored"
 *  invariant exactly). A mutator spreading a `Note` object literal
 *  straight into `writeRecord` type-checks fine (structural widening, not
 *  an excess-property-checked literal) but would silently persist a
 *  redundant, staleness-prone copy of `title` in storage. */
function toRecord(note: Note): NoteRecord {
  const { title: _title, ...record } = note
  return record
}

export async function listNotes(): Promise<Note[]> {
  const all = await LocalStorage.allItems<Record<string, string>>()
  const notes: Note[] = []
  for (const [key, raw] of Object.entries(all)) {
    if (!key.startsWith(NOTE_PREFIX)) continue
    const record = parseRecord(key, raw)
    if (record) notes.push(toNote(record))
  }
  return notes
}

export async function getNote(id: string): Promise<Note | undefined> {
  const raw = await LocalStorage.getItem<string>(`${NOTE_PREFIX}${id}`)
  if (!raw) return undefined
  const record = parseRecord(`${NOTE_PREFIX}${id}`, raw)
  return record ? toNote(record) : undefined
}

export async function createNote(content: string): Promise<Note> {
  const now = Date.now()
  const record: NoteRecord = { id: newNoteId(), content, pinnedAt: null, createdAt: now, updatedAt: now, lastOpenedAt: now }
  await writeRecord(record)
  return toNote(record)
}

export async function updateNoteContent(id: string, content: string): Promise<void> {
  const note = await getNote(id)
  if (!note) return
  await writeRecord({ ...toRecord(note), content, updatedAt: Date.now() })
}

export async function touchNoteOpened(id: string): Promise<void> {
  const note = await getNote(id)
  if (!note) return
  await writeRecord({ ...toRecord(note), lastOpenedAt: Date.now() })
}

export async function setNotePinned(id: string, pinned: boolean): Promise<void> {
  const note = await getNote(id)
  if (!note) return
  await writeRecord({ ...toRecord(note), pinnedAt: pinned ? Date.now() : null })
}

export async function deleteNote(id: string): Promise<void> {
  await LocalStorage.removeItem(`${NOTE_PREFIX}${id}`)
}

export async function duplicateNote(id: string): Promise<Note | undefined> {
  const note = await getNote(id)
  if (!note) return undefined
  return createNote(note.content)
}
