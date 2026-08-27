import { LocalStorage } from '@raycast/api'
import { listQuicklinks, type Quicklink } from './storage'

/**
 * Import/Export hooks for Quicklinks — the reference implementation of the
 * manifest's `export` declaration.
 *
 * The host calls `exportData` when the user exports with Quicklinks
 * checked, stores whatever it returns verbatim under this extension's id,
 * and hands it straight back to `importData` later. Nothing here is
 * interpreted by the host, which is the point: the shape below is ours to
 * change, as long as `importData` keeps understanding the versions we've
 * shipped.
 *
 * Both hooks must stay async and yield: every extension shares one Node
 * process, so synchronous CPU work here blocks the host's liveness probe
 * and gets this export treated as a hang.
 */

/** Bump when the shape below changes in a way `importData` has to branch on. */
export const exportVersion = 1

interface ExportedQuicklink {
  id: string
  title: string
  urlTemplate: string
  icon?: string
  createdAt: number
}

export async function exportData(): Promise<{ quicklinks: ExportedQuicklink[] }> {
  const quicklinks = await listQuicklinks()
  return { quicklinks: quicklinks.map(({ id, title, urlTemplate, icon, createdAt }) => ({ id, title, urlTemplate, icon, createdAt })) }
}

/**
 * Restores quicklinks from an exported payload, keyed by their original
 * ids so re-importing the same file overwrites rather than duplicating.
 * Quicklinks the file doesn't mention are left alone — an import adds and
 * updates, it does not wipe what this machine already had.
 */
export async function importData(data: unknown, version: unknown): Promise<void> {
  if (version !== null && version !== undefined && version !== exportVersion) {
    throw new Error(`unsupported Quicklinks export version ${String(version)} (this build understands ${exportVersion})`)
  }
  const payload = data as { quicklinks?: unknown } | null
  if (!payload || !Array.isArray(payload.quicklinks)) return

  for (const entry of payload.quicklinks as ExportedQuicklink[]) {
    if (typeof entry?.id !== 'string' || typeof entry.title !== 'string' || typeof entry.urlTemplate !== 'string') continue
    const quicklink: Quicklink = {
      id: entry.id,
      title: entry.title,
      urlTemplate: entry.urlTemplate,
      createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : Date.now(),
    }
    if (typeof entry.icon === 'string') quicklink.icon = entry.icon
    await LocalStorage.setItem(quicklink.id, JSON.stringify(quicklink))
  }
}
