import { capabilities } from '@openray/extras'
import { MenuBarSearchList } from './MenuBarSearchList'

/** T30: "menu introspection impossible → no row" — mirrors T29's
 *  screenshots "no scopes → no rows" shape exactly, just gated on a
 *  process-lifetime-static capability instead of a user-editable setting
 *  (so, unlike screenshots, no live-refresh-on-change concern here —
 *  `capabilities.menuBarIntrospection` can't change after the app starts). */
export default async function listRootCommands() {
  if (!capabilities.menuBarIntrospection) return []
  return [{ id: 'search', title: 'Search Menu Bar Items', subtitle: 'Built-in Command', opensView: true, icon: 'search' }]
}

/** Never actually reached: the row above always has `opensView: true`,
 *  which routes activation to `view` below instead — same unreachable-but-
 *  present convention `extensions/translate/src/list.tsx` established. */
export async function execute(): Promise<void> {}

/** Mounted for the 'search' row. */
export function view() {
  return <MenuBarSearchList />
}
