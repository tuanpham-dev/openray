import { useEffect, useState } from 'react'
import { List, ActionPanel, Action } from '@raycast/api'
import { searchNotes, type Note } from '@openray/notes-core'
import { listNotes } from './storage'
import { openOrFocusNote } from './window'

/** `view`: `builtin.search-notes`'s replacement. */
export default function SearchNotesCommand() {
  const [query, setQuery] = useState('')
  const [notes, setNotes] = useState<Note[]>([])

  useEffect(() => {
    void listNotes().then(setNotes)
  }, [])

  const results = searchNotes(notes, query)

  return (
    <List searchText={query} onSearchTextChange={setQuery} navigationTitle="Search Notes">
      {results.map((note) => (
        <List.Item
          key={note.id}
          id={note.id}
          title={note.title}
          subtitle={note.pinnedAt ? 'Pinned' : undefined}
          actions={
            <ActionPanel>
              <Action title="Open Note" icon="note" onAction={() => void openOrFocusNote(note.id)} />
            </ActionPanel>
          }
        />
      ))}
    </List>
  )
}
