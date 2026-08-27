import { showToast, Toast } from '@raycast/api'
import { runAction } from './actions'
import { binaryExists } from './path'
import { CONFIRM_IDS, TABLE, type SystemCommandMeta } from './table'

function isAvailable(entry: SystemCommandMeta): boolean {
  return entry.linuxRequires.every(binaryExists)
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
