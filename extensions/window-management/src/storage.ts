import { LocalStorage } from '@raycast/api'

export type CustomUnit = 'percent' | 'pixels'

export interface WindowCommand {
  id: string
  title: string
  unit: CustomUnit
  x: number | null
  y: number | null
  width: number
  height: number
  createdAt: number
}

function parse(id: string, raw: string): WindowCommand | undefined {
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) return undefined
    const record = value as Record<string, unknown>
    if (typeof record.title !== 'string') return undefined
    if (record.unit !== 'percent' && record.unit !== 'pixels') return undefined
    if (typeof record.width !== 'number' || typeof record.height !== 'number') return undefined
    return {
      id,
      title: record.title,
      unit: record.unit,
      x: typeof record.x === 'number' ? record.x : null,
      y: typeof record.y === 'number' ? record.y : null,
      width: record.width,
      height: record.height,
      createdAt: typeof record.createdAt === 'number' ? record.createdAt : 0,
    }
  } catch {
    return undefined
  }
}

export async function listWindowCommands(): Promise<WindowCommand[]> {
  const all = await LocalStorage.allItems<Record<string, string>>()
  const commands: WindowCommand[] = []
  for (const [id, raw] of Object.entries(all)) {
    const command = parse(id, raw)
    if (command) commands.push(command)
  }
  return commands.sort((a, b) => a.title.localeCompare(b.title))
}

export async function getWindowCommand(id: string): Promise<WindowCommand | undefined> {
  const raw = await LocalStorage.getItem<string>(id)
  return raw === undefined ? undefined : parse(id, raw)
}

function newId(): string {
  return `window.custom.${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export async function createWindowCommand(title: string, unit: CustomUnit, x: number | null, y: number | null, width: number, height: number): Promise<void> {
  const command: WindowCommand = { id: newId(), title, unit, x, y, width, height, createdAt: Date.now() }
  await LocalStorage.setItem(command.id, JSON.stringify(command))
}

export async function updateWindowCommand(
  id: string,
  title: string,
  unit: CustomUnit,
  x: number | null,
  y: number | null,
  width: number,
  height: number,
): Promise<void> {
  const existing = await getWindowCommand(id)
  const command: WindowCommand = { id, title, unit, x, y, width, height, createdAt: existing?.createdAt ?? Date.now() }
  await LocalStorage.setItem(id, JSON.stringify(command))
}

export async function deleteWindowCommand(id: string): Promise<void> {
  await LocalStorage.removeItem(id)
}
