import { getFileSearchSettings } from '@openray/extras'
import { FileSearchList } from './FileSearchList'

/** "No scopes → no rows" — same precedent as Screenshots' `list.tsx`
 *  (`settings.searchScopes.length === 0`). */
export default async function listRootCommands() {
  const settings = await getFileSearchSettings()
  if (settings.scopes.length === 0) return []

  return [{ id: 'search', title: 'Search Files', subtitle: 'Built-in Command', opensView: true, icon: 'search' }]
}

export async function execute(): Promise<void> {
  // 'search' always has `opensView: true` above — never reached.
}

interface ViewProps {
  id: string
}

/** Mounted for the 'search' row (`opensView: true` above). */
export function view(_props: ViewProps) {
  return <FileSearchList />
}
