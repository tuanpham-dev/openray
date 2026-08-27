import { LocalStorage } from '@raycast/api'

export interface Snippet {
  id: string
  name: string
  keyword?: string
  body: string
  createdAt: number
}

function parse(id: string, raw: string): Snippet | undefined {
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) return undefined
    const record = value as Record<string, unknown>
    if (typeof record.name !== 'string' || typeof record.body !== 'string') return undefined
    const snippet: Snippet = {
      id,
      name: record.name,
      body: record.body,
      createdAt: typeof record.createdAt === 'number' ? record.createdAt : 0,
    }
    if (typeof record.keyword === 'string') snippet.keyword = record.keyword
    return snippet
  } catch {
    return undefined
  }
}

export async function listSnippets(): Promise<Snippet[]> {
  const all = await LocalStorage.allItems<Record<string, string>>()
  const snippets: Snippet[] = []
  for (const [id, raw] of Object.entries(all)) {
    const snippet = parse(id, raw)
    if (snippet) snippets.push(snippet)
  }
  return snippets.sort((a, b) => a.name.localeCompare(b.name))
}

export async function getSnippet(id: string): Promise<Snippet | undefined> {
  const raw = await LocalStorage.getItem<string>(id)
  return raw === undefined ? undefined : parse(id, raw)
}

export async function getSnippetByName(name: string): Promise<Snippet | undefined> {
  const snippets = await listSnippets()
  return snippets.find((s) => s.name === name)
}

function newId(): string {
  return `snippet.${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export async function createSnippet(name: string, keyword: string | undefined, body: string): Promise<void> {
  const snippet: Snippet = { id: newId(), name, body, createdAt: Date.now() }
  if (keyword !== undefined && keyword !== '') snippet.keyword = keyword
  await LocalStorage.setItem(snippet.id, JSON.stringify(snippet))
}

export async function updateSnippet(id: string, name: string, keyword: string | undefined, body: string): Promise<void> {
  const existing = await getSnippet(id)
  const snippet: Snippet = { id, name, body, createdAt: existing?.createdAt ?? Date.now() }
  if (keyword !== undefined && keyword !== '') snippet.keyword = keyword
  await LocalStorage.setItem(id, JSON.stringify(snippet))
}

export async function deleteSnippet(id: string): Promise<void> {
  await LocalStorage.removeItem(id)
}
