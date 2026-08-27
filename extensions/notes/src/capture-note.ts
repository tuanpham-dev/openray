import { useEffect } from 'react'
import { createNote } from './storage'
import { openOrFocusNote } from './window'

interface CaptureNoteProps {
  arguments: { text: string }
}

/** `no-view`, one required `text` argument — the quick-capture inline
 *  row's activation target (T26's `InlineRow` extension routes `Enter`
 *  through here via the same `run_extension_command` launch path a
 *  manifest command already uses, `commandName: 'capture-note'`,
 *  `argument: <captured text>`). Creates the note and opens it — matches
 *  native's Enter behavior exactly; there's no `capture-note-quiet`
 *  ⌘-Enter counterpart (disclosed simplification, see
 *  plans/refactor-extension-platform.md's T26 notes). */
export default function CaptureNoteCommand(props: CaptureNoteProps) {
  useEffect(() => {
    void createNote(props.arguments.text).then((note) => openOrFocusNote(note.id))
  }, [])
  return null
}
