import { useEffect } from 'react'
import { toggleNotesWindow } from './window'

/** `no-view`: `builtin.notes`'s replacement — the hotkey-bindable "Notes"
 *  command. Closes the window if one is open, otherwise opens the
 *  most-recently-opened note (or a fresh blank one if none exist yet). */
export default function ToggleNotesCommand() {
  useEffect(() => {
    void toggleNotesWindow()
  }, [])
  return null
}
