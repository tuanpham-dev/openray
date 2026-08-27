import { parseCapture } from '@openray/notes-core'
import { listNotes } from './storage'
import { openOrFocusNote } from './window'

/** Per-note dynamic rows — one per note, sorted pinned-then-recent by
 *  `listNotes` (`@openray/notes-core`'s `sortNotes`, same ordering
 *  `application::notes::select_all` used natively). `opensView` is
 *  deliberately omitted (defaults false): clicking a note opens the
 *  dedicated Notes window (`execute`, below), never a palette view —
 *  matches native `notes.item.<id>`'s own "headless from the palette's
 *  point of view" contract exactly. */
export default async function listRootCommands() {
  const notes = await listNotes()
  return notes.map((note) => ({
    id: note.id,
    title: note.title,
    subtitle: 'Note',
  }))
}

/** Activates one dynamically-contributed row — opens the Notes window
 *  showing this note (`openOrFocusNote`'s single-instance-reuse handles
 *  whether that's a fresh window or an already-open one). */
export async function execute(id: string): Promise<void> {
  await openOrFocusNote(id)
}

interface OnQueryContext {
  aliases: Record<string, string>
}

/** T21 inline row: quick-capture (`"note buy milk"`). Unlike calculator's/
 *  translate's inline rows (a `value` the user copies), "create a note
 *  from this text" has no clipboard-copy reading — this is the first row
 *  shaped as an *activatable* command instead (T26's `InlineRow`
 *  extension: `commandName`/`argument`, routed through the same
 *  `run_extension_command` launch path a manifest command already uses).
 *  Enter-only, no ⌘↵ "create silently" variant — disclosed simplification
 *  vs. native (see plans/refactor-extension-platform.md's T26 notes). */
export async function onQuery(query: string, context: OnQueryContext) {
  // Matches native's own `parse_capture(query, aliases.get(NOTES_COMMAND_ID))`:
  // the alias that unlocks quick-capture is whichever one the user assigned
  // to the "Notes" toggle command specifically (`toggle-notes` here), not a
  // capture-specific alias of its own.
  const text = parseCapture(query, context.aliases['toggle-notes'])
  if (!text) return null

  return {
    id: 'capture',
    title: `Create Note: "${text}"`,
    subtitle: 'Note',
    commandName: 'capture-note',
    argument: text,
    icon: 'note',
    display: 'card',
    sectionLabel: 'Create Note',
    cardRight: text,
  }
}
