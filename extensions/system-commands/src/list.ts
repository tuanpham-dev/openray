import { showToast, Toast } from '@raycast/api'
import { runAction } from './actions'
import { binaryExists } from './path'
import { CONFIRM_IDS, TABLE, type SystemCommandMeta } from './table'

// This extension's Linux actions (`actions.ts`) shell out to Linux-only
// tools (wpctl/pactl/systemctl/...) with no direct macOS equivalent —
// `linuxRequires` alone doesn't catch that on macOS: a row declaring no
// required *Linux* binaries (e.g. every volume-* row) would otherwise
// fall through as "available" there too, then fail silently the moment
// its action ran (caught by `execute()` below, reported only as a toast
// a headless caller never sees). macOS gets its own real actions
// (`table.ts`'s `macosSupported`) instead of reusing the Linux ones —
// still no `linuxRequires`-style PATH probing needed there, since
// `osascript`/`pmset`/`open` ship on every real Mac. Windows has neither
// side implemented, so it stays gated out entirely.
function isAvailable(entry: SystemCommandMeta): boolean {
  if (process.platform === 'linux') return entry.linuxRequires.every(binaryExists)
  if (process.platform === 'darwin') return entry.macosSupported !== false
  return false
}

export default async function listRootCommands() {
  return TABLE.filter(isAvailable).map((entry) => ({
    id: entry.id,
    title: entry.title,
    subtitle: 'System',
    icon: entry.icon,
    keywords: entry.keywords,
    needsConfirm: CONFIRM_IDS.has(entry.id),
    opensView: false,
  }))
}

export async function execute(id: string): Promise<void> {
  const entry = TABLE.find((e) => e.id === id)
  if (!entry) return
  try {
    await runAction(id)
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: entry.title,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}
