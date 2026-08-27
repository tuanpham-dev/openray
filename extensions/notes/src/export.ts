import { LocalStorage } from '@raycast/api'

/**
 * Import/Export hooks for Notes.
 *
 * A faithful key/value copy of this extension's own storage: whatever
 * shape the extension writes today is what travels, so adding a field
 * needs no change here. The host stores the returned value verbatim and
 * hands it straight back to `importData`.
 *
 * Both hooks stay async and yield — every extension shares one Node
 * process, so synchronous work here would block the host's liveness probe
 * and get this export treated as a hang.
 */

/** Bump when the shape below changes in a way `importData` must branch on. */
export const exportVersion = 1

/** Keys never worth carrying to another machine. `secret:` is
 *  excluded on principle: credentials are the one thing an export must
 *  never pick up by accident, and the host's own storage export already
 *  refuses them (migration 0026). */
const EXCLUDED_PREFIXES = ['secret:']

function isPortable(key: string): boolean {
  return !EXCLUDED_PREFIXES.some((prefix) => key.startsWith(prefix))
}

export async function exportData(): Promise<{ items: Record<string, string> }> {
  const all = await LocalStorage.allItems<Record<string, string>>()
  const items: Record<string, string> = {}
  for (const [key, value] of Object.entries(all)) {
    if (isPortable(key)) items[key] = value
  }
  return { items }
}

/**
 * Restores entries under their original keys, so re-importing the same
 * file overwrites rather than duplicating. Entries this machine has that
 * the file doesn't mention are left alone — an import adds and updates,
 * it never wipes.
 */
export async function importData(data: unknown, version: unknown): Promise<void> {
  if (version !== null && version !== undefined && version !== exportVersion) {
    throw new Error(`unsupported Notes export version ${String(version)} (this build understands ${exportVersion})`)
  }
  const payload = data as { items?: unknown } | null
  if (!payload || typeof payload.items !== 'object' || payload.items === null) return

  for (const [key, value] of Object.entries(payload.items as Record<string, unknown>)) {
    if (typeof value !== 'string' || !isPortable(key)) continue
    await LocalStorage.setItem(key, value)
  }
}
