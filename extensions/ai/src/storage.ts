import { LocalStorage } from '@raycast/api'
import { BUILTIN_AI_COMMANDS, sortChats, type ChatRecord } from '@openray/ai-core'

/**
 * All AI storage as plain `LocalStorage`-backed CRUD — same shape as
 * `extensions/notes/src/storage.ts`, generalized to AI's six entity
 * kinds. Port of `src-tauri/src/application/ai/storage.rs`.
 *
 * Keys prefixed `secret:` (provider API keys, MCP OAuth tokens, MCP
 * client secrets) are excluded from Import/Export's `extension_storage`
 * export — see `application::transfer::snapshot`'s `EXCLUDED_KEY_PREFIX`
 * (T27; native never had this — provider keys/MCP secrets were plain
 * `ai_provider_keys`/`mcp_servers` SQLite columns exported wholesale like
 * everything else. This tightens on native, doesn't just port it).
 */

const CHAT_PREFIX = 'chat:'
const MESSAGE_PREFIX = 'message:'
const AGENT_PREFIX = 'agent:'
const COMMAND_PREFIX = 'command:'
const MCP_SERVER_PREFIX = 'mcp-server:'
const PROVIDER_KEY_PREFIX = 'secret:provider-key:'
const MCP_SECRET_PREFIX = 'secret:mcp-server-secret:'
const MCP_OAUTH_PREFIX = 'secret:mcp-oauth:'
const MEMORY_KEY = 'memory'

function newId(prefix: string): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  const random = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${prefix}.${Date.now().toString(36)}${random}`
}

async function readJson<T>(key: string): Promise<T | undefined> {
  const raw = await LocalStorage.getItem<string>(key)
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

async function writeJson(key: string, value: unknown): Promise<void> {
  await LocalStorage.setItem(key, JSON.stringify(value))
}

async function listByPrefix<T>(prefix: string): Promise<T[]> {
  const all = await LocalStorage.allItems<Record<string, string>>()
  const out: T[] = []
  for (const [key, raw] of Object.entries(all)) {
    if (!key.startsWith(prefix)) continue
    try {
      out.push(JSON.parse(raw) as T)
    } catch {
      // skip corrupt entries
    }
  }
  return out
}

// ---- provider keys --------------------------------------------------------

export interface ProviderKeyRecord {
  provider: string
  apiKey: string
  baseUrl: string | null
  enabled: boolean
}

export async function setProviderKey(provider: string, apiKey: string, baseUrl: string | undefined): Promise<void> {
  await writeJson(`${PROVIDER_KEY_PREFIX}${provider}`, { provider, apiKey, baseUrl: baseUrl ?? null, enabled: true })
}

export async function getProviderKey(provider: string): Promise<{ apiKey: string; baseUrl: string | null } | undefined> {
  const record = await readJson<ProviderKeyRecord>(`${PROVIDER_KEY_PREFIX}${provider}`)
  if (!record || !record.enabled) return undefined
  return { apiKey: record.apiKey, baseUrl: record.baseUrl }
}

export async function listProviderKeys(): Promise<ProviderKeyRecord[]> {
  const records = await listByPrefix<ProviderKeyRecord>(PROVIDER_KEY_PREFIX)
  return records.sort((a, b) => a.provider.localeCompare(b.provider))
}

export async function deleteProviderKey(provider: string): Promise<void> {
  await LocalStorage.removeItem(`${PROVIDER_KEY_PREFIX}${provider}`)
}

// ---- chats & messages -------------------------------------------------

export async function insertChat(id: string, title: string, agentId: string | undefined, model: string | undefined, quick: boolean): Promise<void> {
  const now = Date.now()
  const record: ChatRecord = { id, title, pinned: false, archived: false, quick, agentId: agentId ?? null, model: model ?? null, createdAt: now, updatedAt: now }
  await writeJson(`${CHAT_PREFIX}${id}`, record)
}

export async function createChat(title: string, agentId: string | undefined, model: string | undefined, quick: boolean): Promise<string> {
  const id = newId('ai.chat')
  await insertChat(id, title, agentId, model, quick)
  return id
}

export async function touchChat(id: string): Promise<void> {
  const chat = await getChat(id)
  if (!chat) return
  await writeJson(`${CHAT_PREFIX}${id}`, { ...chat, updatedAt: Date.now() })
}

export async function setChatPinned(id: string, pinned: boolean): Promise<void> {
  const chat = await getChat(id)
  if (!chat) return
  await writeJson(`${CHAT_PREFIX}${id}`, { ...chat, pinned })
}

export async function setChatArchived(id: string, archived: boolean): Promise<void> {
  const chat = await getChat(id)
  if (!chat) return
  await writeJson(`${CHAT_PREFIX}${id}`, { ...chat, archived })
}

export async function promoteQuickChat(id: string): Promise<void> {
  const chat = await getChat(id)
  if (!chat) return
  await writeJson(`${CHAT_PREFIX}${id}`, { ...chat, quick: false })
}

export async function renameChat(id: string, title: string): Promise<void> {
  const chat = await getChat(id)
  if (!chat) return
  await writeJson(`${CHAT_PREFIX}${id}`, { ...chat, title })
}

export async function getChat(id: string): Promise<ChatRecord | undefined> {
  return readJson<ChatRecord>(`${CHAT_PREFIX}${id}`)
}

export async function listChats(): Promise<ChatRecord[]> {
  return sortChats(await listByPrefix<ChatRecord>(CHAT_PREFIX))
}

export async function deleteChat(id: string): Promise<void> {
  const messages = await listMessages(id)
  for (const message of messages) await LocalStorage.removeItem(`${MESSAGE_PREFIX}${id}:${message.id}`)
  await LocalStorage.removeItem(`${CHAT_PREFIX}${id}`)
}

export interface MessageRecord {
  id: string
  chatId: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
}

export async function insertMessage(chatId: string, role: 'user' | 'assistant', content: string): Promise<MessageRecord> {
  const record: MessageRecord = { id: newId('ai.msg'), chatId, role, content, createdAt: Date.now() }
  await writeJson(`${MESSAGE_PREFIX}${chatId}:${record.id}`, record)
  return record
}

export async function listMessages(chatId: string): Promise<MessageRecord[]> {
  const records = await listByPrefix<MessageRecord>(`${MESSAGE_PREFIX}${chatId}:`)
  return records.sort((a, b) => a.createdAt - b.createdAt)
}

/** Deletes the chat's most recent message if (and only if) it's an
 *  assistant reply — the first step of "regenerate". */
export async function deleteLastAssistantMessage(chatId: string): Promise<void> {
  const messages = await listMessages(chatId)
  const last = messages[messages.length - 1]
  if (last && last.role === 'assistant') {
    await LocalStorage.removeItem(`${MESSAGE_PREFIX}${chatId}:${last.id}`)
  }
}

// ---- agents -----------------------------------------------------------

export interface AgentRecord {
  id: string
  name: string
  icon: string | null
  instructions: string
  model: string | null
}

export async function createAgent(name: string, icon: string | undefined, instructions: string, model: string | undefined): Promise<string> {
  const id = newId('ai.agent')
  await writeJson(`${AGENT_PREFIX}${id}`, { id, name, icon: icon ?? null, instructions, model: model ?? null } satisfies AgentRecord)
  return id
}

export async function updateAgent(id: string, name: string, icon: string | undefined, instructions: string, model: string | undefined): Promise<void> {
  await writeJson(`${AGENT_PREFIX}${id}`, { id, name, icon: icon ?? null, instructions, model: model ?? null } satisfies AgentRecord)
}

export async function deleteAgent(id: string): Promise<void> {
  await LocalStorage.removeItem(`${AGENT_PREFIX}${id}`)
}

export async function getAgent(id: string): Promise<AgentRecord | undefined> {
  return readJson<AgentRecord>(`${AGENT_PREFIX}${id}`)
}

export async function listAgents(): Promise<AgentRecord[]> {
  const records = await listByPrefix<AgentRecord>(AGENT_PREFIX)
  return records.sort((a, b) => a.name.localeCompare(b.name))
}

// ---- AI commands --------------------------------------------------------

export interface CommandRecord {
  id: string
  name: string
  prompt: string
  model: string | null
  creativity: string
  outputMode: string
  builtin: boolean
  createdAt: number
}

/** Seeds the built-in commands, insert-if-absent so a user's own edits
 *  survive across restarts — matches `AiProvider::seed_builtin_commands`. */
export async function seedBuiltinCommands(): Promise<void> {
  for (const builtin of BUILTIN_AI_COMMANDS) {
    const id = `command:builtin.${builtin.slug}`
    const existing = await LocalStorage.getItem<string>(id)
    if (existing !== undefined) continue
    const record: CommandRecord = { id, name: builtin.name, prompt: builtin.prompt, model: null, creativity: builtin.creativity, outputMode: builtin.outputMode, builtin: true, createdAt: Date.now() }
    await writeJson(id, record)
  }
}

export async function createCommand(name: string, prompt: string, model: string | undefined, creativity: string, outputMode: string): Promise<string> {
  const id = newId('command:custom')
  const record: CommandRecord = { id, name, prompt, model: model ?? null, creativity, outputMode, builtin: false, createdAt: Date.now() }
  await writeJson(id, record)
  return id
}

export async function updateCommand(id: string, name: string, prompt: string, model: string | undefined, creativity: string, outputMode: string): Promise<void> {
  const existing = await getCommand(id)
  if (!existing) return
  await writeJson(id, { ...existing, name, prompt, model: model ?? null, creativity, outputMode } satisfies CommandRecord)
}

export async function deleteCommand(id: string): Promise<void> {
  await LocalStorage.removeItem(id)
}

export async function getCommand(id: string): Promise<CommandRecord | undefined> {
  return readJson<CommandRecord>(id)
}

export async function listCommands(): Promise<CommandRecord[]> {
  const records = await listByPrefix<CommandRecord>(COMMAND_PREFIX)
  return records.sort((a, b) => (a.builtin === b.builtin ? a.name.localeCompare(b.name) : a.builtin ? -1 : 1))
}

// ---- MCP servers --------------------------------------------------------

export interface McpServerRecord {
  id: string
  name: string
  icon: string | null
  transport: 'stdio' | 'http'
  command: string | null
  args: string[] | null
  env: Record<string, string> | null
  url: string | null
  headers: Record<string, string> | null
  oauthType: 'dynamic' | 'static' | null
  oauthClientId: string | null
  oauthScopes: string | null
  instructions: string | null
  enabled: boolean
  alwaysAllow: boolean
  createdAt: number
}

export interface McpServerInput {
  name: string
  icon?: string
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  oauthType?: 'dynamic' | 'static'
  oauthClientId?: string
  oauthClientSecret?: string
  oauthScopes?: string
  instructions?: string
}

export async function createMcpServer(input: McpServerInput): Promise<string> {
  const id = newId('mcp')
  const record: McpServerRecord = {
    id,
    name: input.name,
    icon: input.icon ?? null,
    transport: input.transport,
    command: input.command ?? null,
    args: input.args ?? null,
    env: input.env ?? null,
    url: input.url ?? null,
    headers: input.headers ?? null,
    oauthType: input.oauthType ?? null,
    oauthClientId: input.oauthClientId ?? null,
    oauthScopes: input.oauthScopes ?? null,
    instructions: input.instructions ?? null,
    enabled: true,
    alwaysAllow: false,
    createdAt: Date.now(),
  }
  await writeJson(`${MCP_SERVER_PREFIX}${id}`, record)
  if (input.oauthClientSecret) {
    await writeJson(`${MCP_SECRET_PREFIX}${id}`, { clientSecret: input.oauthClientSecret })
  }
  return id
}

export async function deleteMcpServer(id: string): Promise<void> {
  await LocalStorage.removeItem(`${MCP_SERVER_PREFIX}${id}`)
  await LocalStorage.removeItem(`${MCP_SECRET_PREFIX}${id}`)
  await LocalStorage.removeItem(`${MCP_OAUTH_PREFIX}${id}`)
}

export async function setMcpServerEnabled(id: string, enabled: boolean): Promise<void> {
  const server = await getMcpServer(id)
  if (!server) return
  await writeJson(`${MCP_SERVER_PREFIX}${id}`, { ...server, enabled })
}

export async function setMcpServerAlwaysAllow(id: string, alwaysAllow: boolean): Promise<void> {
  const server = await getMcpServer(id)
  if (!server) return
  await writeJson(`${MCP_SERVER_PREFIX}${id}`, { ...server, alwaysAllow })
}

export async function getMcpServer(id: string): Promise<McpServerRecord | undefined> {
  return readJson<McpServerRecord>(`${MCP_SERVER_PREFIX}${id}`)
}

export async function listMcpServers(): Promise<McpServerRecord[]> {
  const records = await listByPrefix<McpServerRecord>(MCP_SERVER_PREFIX)
  return records.sort((a, b) => a.name.localeCompare(b.name))
}

export async function listEnabledMcpServers(): Promise<McpServerRecord[]> {
  return (await listMcpServers()).filter((s) => s.enabled)
}

export async function getMcpServerClientSecret(id: string): Promise<string | undefined> {
  const record = await readJson<{ clientSecret: string }>(`${MCP_SECRET_PREFIX}${id}`)
  return record?.clientSecret
}

export interface McpOAuthTokens {
  accessToken: string
  refreshToken: string | null
  expiresAt: number | null
}

export async function setMcpOAuthTokens(serverId: string, tokens: McpOAuthTokens): Promise<void> {
  await writeJson(`${MCP_OAUTH_PREFIX}${serverId}`, tokens)
}

export async function getMcpOAuthTokens(serverId: string): Promise<McpOAuthTokens | undefined> {
  return readJson<McpOAuthTokens>(`${MCP_OAUTH_PREFIX}${serverId}`)
}

export async function deleteMcpOAuthTokens(serverId: string): Promise<void> {
  await LocalStorage.removeItem(`${MCP_OAUTH_PREFIX}${serverId}`)
}

// ---- personalization memory ----------------------------------------------

/**
 * An AI-inferred, evolving summary of what the assistant has learned about
 * the user across conversations — distinct from `aiProfile` (static,
 * user-typed, lives in native `Settings`). A single value, not a
 * prefix-listed collection like agents/commands, since there's exactly one
 * memory at a time.
 */
export async function getMemory(): Promise<string> {
  return (await LocalStorage.getItem<string>(MEMORY_KEY)) ?? ''
}

export async function setMemory(text: string): Promise<void> {
  await LocalStorage.setItem(MEMORY_KEY, text)
}

export async function clearMemory(): Promise<void> {
  await LocalStorage.removeItem(MEMORY_KEY)
}
