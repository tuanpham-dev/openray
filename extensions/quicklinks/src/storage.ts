import { LocalStorage } from '@raycast/api'

export interface Quicklink {
  id: string
  title: string
  urlTemplate: string
  icon?: string
  createdAt: number
}

function parse(id: string, raw: string): Quicklink | undefined {
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) return undefined
    const record = value as Record<string, unknown>
    if (typeof record.title !== 'string' || typeof record.urlTemplate !== 'string') return undefined
    const quicklink: Quicklink = {
      id,
      title: record.title,
      urlTemplate: record.urlTemplate,
      createdAt: typeof record.createdAt === 'number' ? record.createdAt : 0,
    }
    if (typeof record.icon === 'string') quicklink.icon = record.icon
    return quicklink
  } catch {
    return undefined
  }
}

export async function listQuicklinks(): Promise<Quicklink[]> {
  const all = await LocalStorage.allItems<Record<string, string>>()
  const quicklinks: Quicklink[] = []
  for (const [id, raw] of Object.entries(all)) {
    const quicklink = parse(id, raw)
    if (quicklink) quicklinks.push(quicklink)
  }
  return quicklinks.sort((a, b) => a.title.localeCompare(b.title))
}

export async function getQuicklink(id: string): Promise<Quicklink | undefined> {
  const raw = await LocalStorage.getItem<string>(id)
  return raw === undefined ? undefined : parse(id, raw)
}

function newId(): string {
  return `quicklink.${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export async function createQuicklink(title: string, urlTemplate: string, icon?: string): Promise<void> {
  const quicklink: Quicklink = { id: newId(), title, urlTemplate, createdAt: Date.now() }
  if (icon !== undefined) quicklink.icon = icon
  await LocalStorage.setItem(quicklink.id, JSON.stringify(quicklink))
}

export async function updateQuicklink(id: string, title: string, urlTemplate: string, icon?: string): Promise<void> {
  const existing = await getQuicklink(id)
  const quicklink: Quicklink = { id, title, urlTemplate, createdAt: existing?.createdAt ?? Date.now() }
  if (icon !== undefined) quicklink.icon = icon
  await LocalStorage.setItem(id, JSON.stringify(quicklink))
}

export async function deleteQuicklink(id: string): Promise<void> {
  await LocalStorage.removeItem(id)
}
