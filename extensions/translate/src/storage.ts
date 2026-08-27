import { LocalStorage } from '@raycast/api'

/** Two logical collections share one extension's `LocalStorage` bucket —
 * `pair:`/`history:` key prefixes distinguish them, matching the shape
 * migration `0024_translate_to_extension_storage.sql` writes into
 * `extension_storage` for pre-existing rows. */
const PAIR_PREFIX = 'pair:'
const HISTORY_PREFIX = 'history:'
const HISTORY_LIMIT = 100

export interface TranslateCommand {
  id: string
  title: string
  sourceLang: string
  targetLang: string
  createdAt: number
}

export interface HistoryEntry {
  id: string
  sourceText: string
  translatedText: string
  detectedLang?: string
  targetLang: string
  createdAt: number
}

function newId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function parsePair(key: string, raw: string): TranslateCommand | undefined {
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) return undefined
    const record = value as Record<string, unknown>
    if (typeof record.title !== 'string' || typeof record.sourceLang !== 'string' || typeof record.targetLang !== 'string') return undefined
    return {
      id: typeof record.id === 'string' ? record.id : key.slice(PAIR_PREFIX.length),
      title: record.title,
      sourceLang: record.sourceLang,
      targetLang: record.targetLang,
      createdAt: typeof record.createdAt === 'number' ? record.createdAt : 0,
    }
  } catch {
    return undefined
  }
}

export async function listTranslateCommands(): Promise<TranslateCommand[]> {
  const all = await LocalStorage.allItems<Record<string, string>>()
  const commands: TranslateCommand[] = []
  for (const [key, raw] of Object.entries(all)) {
    if (!key.startsWith(PAIR_PREFIX)) continue
    const command = parsePair(key, raw)
    if (command) commands.push(command)
  }
  return commands.sort((a, b) => a.title.localeCompare(b.title))
}

export async function getTranslateCommand(id: string): Promise<TranslateCommand | undefined> {
  const raw = await LocalStorage.getItem<string>(`${PAIR_PREFIX}${id}`)
  return raw === undefined ? undefined : parsePair(`${PAIR_PREFIX}${id}`, raw)
}

export async function createTranslateCommand(title: string, sourceLang: string, targetLang: string): Promise<string> {
  const id = newId()
  const command: TranslateCommand = { id, title, sourceLang, targetLang, createdAt: Date.now() }
  await LocalStorage.setItem(`${PAIR_PREFIX}${id}`, JSON.stringify(command))
  return id
}

export async function updateTranslateCommand(id: string, title: string, sourceLang: string, targetLang: string): Promise<void> {
  const existing = await getTranslateCommand(id)
  const command: TranslateCommand = { id, title, sourceLang, targetLang, createdAt: existing?.createdAt ?? Date.now() }
  await LocalStorage.setItem(`${PAIR_PREFIX}${id}`, JSON.stringify(command))
}

export async function deleteTranslateCommand(id: string): Promise<void> {
  await LocalStorage.removeItem(`${PAIR_PREFIX}${id}`)
}

function parseHistoryEntry(key: string, raw: string): HistoryEntry | undefined {
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) return undefined
    const record = value as Record<string, unknown>
    if (typeof record.sourceText !== 'string' || typeof record.translatedText !== 'string' || typeof record.targetLang !== 'string') return undefined
    const entry: HistoryEntry = {
      id: typeof record.id === 'string' ? record.id : key.slice(HISTORY_PREFIX.length),
      sourceText: record.sourceText,
      translatedText: record.translatedText,
      targetLang: record.targetLang,
      createdAt: typeof record.createdAt === 'number' ? record.createdAt : 0,
    }
    if (typeof record.detectedLang === 'string') entry.detectedLang = record.detectedLang
    return entry
  } catch {
    return undefined
  }
}

/** Newest first (matches native's `ORDER BY id DESC`) — `createdAt`
 * ties are broken by insertion order via `newId()`'s monotonic-enough
 * `Date.now()` prefix, same as every other storage id in this codebase. */
export async function listHistory(): Promise<HistoryEntry[]> {
  const all = await LocalStorage.allItems<Record<string, string>>()
  const entries: HistoryEntry[] = []
  for (const [key, raw] of Object.entries(all)) {
    if (!key.startsWith(HISTORY_PREFIX)) continue
    const entry = parseHistoryEntry(key, raw)
    if (entry) entries.push(entry)
  }
  return entries.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
}

/** No-op when `historyEnabled` is false — the caller doesn't need to
 * check the setting itself, mirroring native `TranslateProvider::
 * record_history`'s own contract. Prunes down to `HISTORY_LIMIT`,
 * oldest dropped, on every insert. */
export async function recordHistory(
  sourceText: string,
  translatedText: string,
  detectedLang: string | undefined,
  targetLang: string,
  historyEnabled: boolean,
): Promise<void> {
  if (!historyEnabled) return
  const id = newId()
  const entry: HistoryEntry = { id, sourceText, translatedText, targetLang, createdAt: Date.now() }
  if (detectedLang !== undefined) entry.detectedLang = detectedLang
  await LocalStorage.setItem(`${HISTORY_PREFIX}${id}`, JSON.stringify(entry))

  const all = await listHistory()
  const overflow = all.slice(HISTORY_LIMIT)
  await Promise.all(overflow.map((old) => LocalStorage.removeItem(`${HISTORY_PREFIX}${old.id}`)))
}
