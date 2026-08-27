import { getHostBridge } from '../bridge'

/** T26: the one Notes setting that survived the move to the extension —
 * `alwaysOnTop` affects native window *creation* (T24's
 * `ExtensionWindowOptions`), so unlike ordinary extension data it can't
 * just live in this extension's own storage; it's read live, same
 * reasoning as `host.translate.getSettings`. Not live-applied to an
 * already-open window (disclosed simplification vs. native, which called
 * `window.set_always_on_top()` on toggle) — it takes effect the next time
 * the window opens. */
export interface NotesSettings {
  alwaysOnTop: boolean
}

export async function getNotesSettings(): Promise<NotesSettings> {
  return (await getHostBridge().call('host.notes.getSettings')) as unknown as NotesSettings
}
