import { getScriptDirectories, allowAssetDirectory } from '@openray/extras'
import { discoverScripts, expandHome, type ScriptCommand } from '@openray/script-discovery'

/** Reads the Settings pane's configured directories, widens the asset
 * protocol scope to cover each (so a script-relative icon image can be
 * served), and scans. Mirrors native `ScriptCommandProvider::scripts()` —
 * minus its 3-second cache, since `list.ts`/`view.tsx` each call this at
 * most once per activation, not on every keystroke the way the native
 * provider's `commands()` did. */
export async function findScripts(): Promise<ScriptCommand[]> {
  const directories = await getScriptDirectories()
  await Promise.all(directories.map((dir) => allowAssetDirectory(expandHome(dir))))
  return discoverScripts(directories)
}
