import { getHostBridge } from '../bridge'

/** TS mirror of the backend's `FileEntry` — same boundary-naming split
 *  `screenshots.ts`'s `ScreenshotEntry` uses. */
export interface FileSearchEntry {
  path: string
  name: string
}

export interface FileSearchSettings {
  scopes: string[]
}

/** The File Search pane's one field (`FileSearchPane.tsx`, which stays
 *  native), read live, same reasoning as `getScreenshotsSettings`. */
export async function getFileSearchSettings(): Promise<FileSearchSettings> {
  return (await getHostBridge().call('host.fileSearch.getSettings')) as unknown as FileSearchSettings
}

/** Fuzzy filename search over the configured scopes' SQLite-cached index —
 *  never walks the filesystem itself. Also kicks the background index
 *  sweep, so results fill in over subsequent calls once scopes are freshly
 *  configured. */
export async function queryFileSearch(query: string): Promise<FileSearchEntry[]> {
  return ((await getHostBridge().call('host.fileSearch.query', { query })) ?? []) as FileSearchEntry[]
}
