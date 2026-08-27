import { getHostBridge } from '../bridge'

/** The Settings pane's user-configured script-command directories
 * (`GeneralPane.tsx`'s "Script Directories" field) — live app-wide
 * Settings state, not this extension's own data, read fresh on every
 * listing refresh the same way native `ScriptCommandProvider` did. */
export async function getScriptDirectories(): Promise<string[]> {
  return ((await getHostBridge().call('host.system.getScriptDirectories')) ?? []) as string[]
}

/** Widens the asset protocol's scope to cover `path` so a script-relative
 * icon image (outside the static build-time scope) can be served via
 * `convertFileSrc` on the frontend. Idempotent — safe to call on every
 * listing refresh, matching native's own per-scan `allow_directory` call. */
export async function allowAssetDirectory(path: string): Promise<void> {
  await getHostBridge().call('host.system.allowAssetDirectory', { path })
}
