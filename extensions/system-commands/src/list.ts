import { showToast, Toast } from '@raycast/api'
import { runAction } from './actions'
import { binaryExists } from './path'
import { CONFIRM_IDS, TABLE, type SystemCommandMeta } from './table'

// This extension's actions (`actions.ts`) shell out to Linux-only tools
// (wpctl/pactl/systemctl/...) with no macOS/Windows equivalent — see
// table.ts's header comment. `linuxRequires` alone doesn't catch that: a
// row declaring no required binaries (e.g. every volume-* row) fell
// through as "available" on macOS/Windows too, then failed silently the
// moment its action ran (caught by `execute()` below, reported only as a
// toast a headless caller never sees). Gating the whole table on the
// platform, not just each row's binaries, keeps a non-Linux desktop from
// ever being offered a command that cannot work at all.
function isAvailable(entry: SystemCommandMeta): boolean {
  return process.platform === 'linux' && entry.linuxRequires.every(binaryExists)
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
