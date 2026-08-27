import { useEffect, useState, useSyncExternalStore } from 'react'
import { List, ActionPanel, Action, useNavigation } from '@raycast/api'
import { MarkdownEditor, openExtensionWindow, getNotesSettings } from '@openray/extras'
import type { Note } from '@openray/notes-core'
import { listNotes, getNote, updateNoteContent, createNote, setNotePinned, deleteNote, duplicateNote, touchNoteOpened } from './storage'

/**
 * T26: cross-command-bundle state. Each command (`list.ts`, `create-note`,
 * `capture-note`, `toggle-notes`) is its own separate esbuild bundle (one
 * `.openray/build/{command}.js` per manifest command) — a plain module-level
 * variable here would be a *different* variable in each of them, the exact
 * problem `packages/api-shim/src/global-slot.ts` documents for the
 * host-vs-extension-bundle boundary. The same fix applies one level
 * further in: anchor the shared state on `globalThis` so every command's
 * own copy of this module reads/writes the identical object, all inside
 * the one long-lived Node sidecar process.
 */
interface NotesWindowState {
  handle: { close(): void; focus(): void } | null
  opening: Promise<void> | null
  currentNoteId: string | null
  listeners: Set<() => void>
}

function store(): NotesWindowState {
  const g = globalThis as Record<string, unknown>
  if (!g.__notesWindowState) {
    const state: NotesWindowState = { handle: null, opening: null, currentNoteId: null, listeners: new Set() }
    g.__notesWindowState = state
  }
  return g.__notesWindowState as NotesWindowState
}

function setCurrentNoteId(id: string): void {
  store().currentNoteId = id
  store().listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void): () => void {
  store().listeners.add(listener)
  return () => store().listeners.delete(listener)
}

/**
 * The single path every "open a note" entry point converges on (root
 * search rows, quick-capture, Create Note, Browse, ⌘N) — mirrors native
 * `NotesProvider::open_note`'s own "the one path every open goes through"
 * role exactly. Reuses one persistent window across calls the way native
 * `notes_window()` reused its single `WebviewWindow` — T24's own window
 * primitive mints a fresh window per `openExtensionWindow` call, so
 * single-instance reuse is handled here, extension-side, by holding onto
 * the returned handle: a second call updates the shared note-id store
 * (which `NotesWindowView`'s `useSyncExternalStore` below re-renders on)
 * and focuses the existing window instead of creating another one.
 */
export async function openOrFocusNote(id: string): Promise<void> {
  setCurrentNoteId(id)
  const state = store()
  if (state.handle) {
    await touchNoteOpened(id)
    state.handle.focus()
    return
  }
  if (state.opening) {
    await touchNoteOpened(id)
    await state.opening
    state.handle?.focus()
    return
  }

  const opening = (async () => {
    await touchNoteOpened(id)
    const settings = await getNotesSettings()
    state.handle = await openExtensionWindow(<NotesWindowView />, {
      title: 'Notes',
      decorations: false,
      alwaysOnTop: settings.alwaysOnTop,
      width: 700,
      height: 500,
      onClose: () => {
        state.handle = null
      },
    })
  })()
  state.opening = opening

  try {
    await opening
  } finally {
    if (state.opening === opening) state.opening = null
  }
}

/** `builtin.notes`'s toggle behavior — close if a window is already open,
 *  otherwise open with the most-recently-opened note (or a fresh blank one
 *  if none exist yet). */
export async function toggleNotesWindow(): Promise<void> {
  const state = store()
  if (state.handle) {
    state.handle.close()
    state.handle = null
    return
  }
  const notes = await listNotes()
  const note = notes[0] ?? (await createNote(''))
  await openOrFocusNote(note.id)
}

function BrowseList({ onSelect }: { onSelect: (id: string) => void }) {
  const [notes, setNotes] = useState<Note[]>([])
  const { pop } = useNavigation()

  useEffect(() => {
    void listNotes().then(setNotes)
  }, [])

  return (
    <List navigationTitle="Browse Notes">
      {notes.map((note) => (
        <List.Item
          key={note.id}
          id={note.id}
          title={note.title}
          subtitle={note.pinnedAt ? 'Pinned' : undefined}
          actions={
            <ActionPanel>
              <Action
                title="Open Note"
                onAction={() => {
                  pop()
                  onSelect(note.id)
                }}
              />
            </ActionPanel>
          }
        />
      ))}
    </List>
  )
}

function NotesWindowView() {
  const noteId = useSyncExternalStore(subscribe, () => store().currentNoteId)
  const [note, setNote] = useState<Note | null>(null)
  const { push } = useNavigation()

  useEffect(() => {
    let cancelled = false
    if (!noteId) {
      setNote(null)
      return
    }
    void getNote(noteId).then((next) => {
      if (!cancelled && next) setNote(next)
    })
    return () => {
      cancelled = true
    }
  }, [noteId])

  if (!noteId || !note) {
    return <MarkdownEditor id="loading" value="" onChange={() => {}} placeholder="Loading…" />
  }

  const openNoteById = (id: string) => void openOrFocusNote(id)

  return (
    <MarkdownEditor
      id={note.id}
      value={note.content}
      placeholder="Start typing…"
      onChange={(markdown) => void updateNoteContent(note.id, markdown)}
      actions={
        <ActionPanel>
          <Action
            title="Create Note"
            shortcut={{ modifiers: ['cmd'], key: 'n' }}
            onAction={() => void createNote('').then((created) => openNoteById(created.id))}
          />
          <Action title="Browse Notes" shortcut={{ modifiers: ['cmd'], key: 'p' }} onAction={() => push(<BrowseList onSelect={openNoteById} />)} />
          <Action
            title={note.pinnedAt ? 'Unpin Note' : 'Pin Note'}
            onAction={() => void setNotePinned(note.id, !note.pinnedAt).then(() => setCurrentNoteId(note.id))}
          />
          <Action
            title="Duplicate Note"
            onAction={() => void duplicateNote(note.id).then((created) => created && openNoteById(created.id))}
          />
          <Action
            title="Delete Note"
            onAction={() =>
              void deleteNote(note.id).then(async () => {
                const remaining = await listNotes()
                const next = remaining[0] ?? (await createNote(''))
                openNoteById(next.id)
              })
            }
          />
        </ActionPanel>
      }
    />
  )
}
