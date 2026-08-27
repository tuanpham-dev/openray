import { open } from '@raycast/api'
import { listQuicklinks, getQuicklink } from './storage'
import { resolveUrl, takesArgument } from './resolve'

export default async function listRootCommands() {
  const quicklinks = await listQuicklinks()
  return quicklinks.map((quicklink) => ({
    id: quicklink.id,
    title: quicklink.title,
    subtitle: 'Quicklink',
    ...(quicklink.icon !== undefined ? { icon: quicklink.icon } : {}),
    requiresArgument: takesArgument(quicklink.urlTemplate),
  }))
}

export async function execute(id: string, argument?: string): Promise<void> {
  const quicklink = await getQuicklink(id)
  if (!quicklink) return
  const url = await resolveUrl(quicklink.urlTemplate, argument ?? '')
  await open(url)
}
