import { getHostBridge } from '../bridge'

/**
 * Starts developing an extension folder: OpenRay builds it in place, adds
 * its commands to the launcher, and watches it for changes.
 *
 * The platform owns this rather than the caller doing it directly, so the
 * id-collision rules and the watcher's lifetime live in one place — and so
 * a scaffolded extension can be *running* the moment it is created.
 */
export async function developExtension(path: string): Promise<{ id: string; title: string; path: string | null }> {
  return (await getHostBridge().call('host.dev.develop', { path })) as unknown as {
    id: string
    title: string
    path: string | null
  }
}
