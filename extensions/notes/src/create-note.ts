import { useEffect } from 'react'
import { createNote } from './storage'
import { openOrFocusNote } from './window'

/** `no-view`: `builtin.create-note`'s replacement — creates a blank note
 *  and opens it, matching native `NotesProvider::execute`'s
 *  `CREATE_NOTE_COMMAND_ID` arm exactly. */
export default function CreateNoteCommand() {
  useEffect(() => {
    void createNote('').then((note) => openOrFocusNote(note.id))
  }, [])
  return null
}
