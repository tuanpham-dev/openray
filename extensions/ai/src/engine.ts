/**
 * Orchestrates one chat turn: persists the user message, resolves the
 * model to a provider + credentials, assembles the system prompt
 * (profile + agent instructions + skills), runs the provider's streaming
 * call, and — for the one provider with a tool adapter (Anthropic) —
 * loops on MCP tool calls. Port of
 * `src-tauri/src/application/ai/engine.rs`, adapted for direct callback
 * delivery instead of Tauri events (no IPC boundary to cross — this runs
 * in the same process as the UI's own command bundle).
 */
import { resolveBaseUrl, splitModelId } from '@openray/ai-core'
import { resolveProvider, type ChatMessage, type ChatTurn, type ToolSpec } from './providers'
import { discoverSkills } from './skills'
import * as mcpClient from './mcp/client'
import * as mcpOAuth from './mcp/oauth'
import * as storage from './storage'
import type { McpServerRecord } from './storage'

const MAX_TOOL_ROUNDS = 8

/** How many messages accumulate (across all chats sharing a chatId, i.e.
 *  one chat's own turns) before a Personalization Memory update fires —
 *  see `maybeUpdateMemory`. Chosen to keep the added per-turn latency rare
 *  rather than tuned against real usage; revisit during QA. */
const MEMORY_UPDATE_INTERVAL = 6

function buildSystemPrompt(
  profile: string,
  memory: string,
  agentInstructions: string | undefined,
  skills: { info: { name: string; description: string }; body: string }[],
): string | undefined {
  const parts: string[] = []
  if (profile.trim()) parts.push(profile.trim())
  if (memory.trim()) parts.push(`What you remember about the user:\n${memory.trim()}`)
  if (agentInstructions?.trim()) parts.push(agentInstructions.trim())
  if (skills.length > 0) {
    let block = 'You have the following skills available. Apply their guidance whenever relevant to the user\'s request:\n'
    for (const skill of skills) {
      block += `\n### Skill: ${skill.info.name} — ${skill.info.description}\n${skill.body.trim()}\n`
    }
    parts.push(block)
  }
  return parts.length > 0 ? parts.join('\n\n---\n\n') : undefined
}

/** Fetches an OAuth bearer token for `server` if it has one configured,
 *  transparently refreshing an expired token first. */
async function resolveBearer(server: McpServerRecord): Promise<string | undefined> {
  if (!server.oauthType) return undefined
  const tokens = await storage.getMcpOAuthTokens(server.id)
  if (!tokens) return undefined
  const expired = tokens.expiresAt !== null && tokens.expiresAt <= Math.floor(Date.now() / 1000)
  if (!expired) return tokens.accessToken
  if (!tokens.refreshToken || !server.url) return tokens.accessToken
  try {
    const tokenEndpoint = await mcpOAuth.discoverTokenEndpoint(server.url)
    const result = await mcpOAuth.refreshAccessToken(tokenEndpoint, server.oauthClientId ?? '', tokens.refreshToken)
    await storage.setMcpOAuthTokens(server.id, { accessToken: result.accessToken, refreshToken: result.refreshToken ?? null, expiresAt: result.expiresAt ?? null })
    return result.accessToken
  } catch {
    return tokens.accessToken
  }
}

interface ToolRoute {
  server: McpServerRecord
  remoteName: string
  bearer?: string
}

/** Lists tools from every enabled MCP server, tolerating individual
 *  server failures. */
async function gatherMcpTools(): Promise<{ specs: ToolSpec[]; routes: Map<string, ToolRoute> }> {
  const specs: ToolSpec[] = []
  const routes = new Map<string, ToolRoute>()
  for (const server of await storage.listEnabledMcpServers()) {
    const bearer = await resolveBearer(server)
    try {
      const tools = await mcpClient.listTools(server, bearer)
      for (const tool of tools) {
        routes.set(tool.spec.name, { server, remoteName: tool.remoteName, bearer })
        specs.push(tool.spec)
      }
    } catch {
      // an unreachable server contributes no tools, doesn't fail the turn
    }
  }
  return { specs, routes }
}

async function dispatchToolCall(routes: Map<string, ToolRoute>, name: string, input: unknown): Promise<string> {
  const route = routes.get(name)
  if (!route) return `error: unknown tool '${name}'`
  if (!route.server.alwaysAllow) {
    return `error: this tool requires approval — enable "Always Allow" for MCP server '${route.server.name}' in Manage MCP Servers, then ask again`
  }
  try {
    return await mcpClient.callTool(route.server, route.bearer, route.remoteName, input)
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`
  }
}

export interface TurnParams {
  model: string
  apiKey?: string
  baseUrl?: string
  system?: string
  tools: ToolSpec[]
  routes: Map<string, ToolRoute>
  history: ChatMessage[]
}

async function resolveModelCredentials(model: string): Promise<{ apiKey?: string; baseUrl?: string }> {
  const [providerId] = splitModelId(model)
  const stored = await storage.getProviderKey(providerId)
  return { apiKey: stored?.apiKey || undefined, baseUrl: resolveBaseUrl(providerId, stored?.baseUrl ?? undefined) }
}

/** Streams one turn (including its tool-call rounds) and returns the
 *  final assistant text — does not persist; callers persist the result. */
async function streamTurn(params: TurnParams, onDelta: (text: string) => void): Promise<string> {
  const provider = resolveProvider(params.model)
  let finalText = ''
  const history = [...params.history]

  for (let round = 1; ; round++) {
    if (round > MAX_TOOL_ROUNDS) {
      throw new Error('network: the assistant needed more than 8 tool calls to answer — stopping to avoid a runaway loop')
    }

    const turn: ChatTurn = { apiKey: params.apiKey, baseUrl: params.baseUrl, model: params.model, system: params.system, messages: history, tools: params.tools }
    let roundText = ''
    const toolUses: { id: string; name: string; input: unknown }[] = []

    await provider.stream(turn, (event) => {
      if (event.kind === 'delta') {
        roundText += event.text
        onDelta(event.text)
      } else {
        toolUses.push({ id: event.id, name: event.name, input: event.input })
      }
    })

    finalText += roundText
    if (toolUses.length === 0) break

    history.push({ role: 'assistant', content: roundText || `[requesting ${toolUses.length} tool call(s)]` })
    for (const { id, name, input } of toolUses) {
      const resultText = await dispatchToolCall(params.routes, name, input)
      history.push({ role: 'user', content: `[Tool result for ${name} (${id})]: ${resultText}` })
    }
  }

  return finalText
}

export interface SendParams {
  chatId: string
  model: string
  content: string
  profile: string
  skillDirs: string[]
}

/** The full send flow for a chat message: persist, stream (with a tool
 *  loop for tool-capable providers), persist the reply. */
export async function runSend(params: SendParams, onDelta: (text: string) => void): Promise<void> {
  await storage.insertMessage(params.chatId, 'user', params.content)

  const chat = await storage.getChat(params.chatId)
  const agent = chat?.agentId ? await storage.listAgents().then((agents) => agents.find((a) => a.id === chat.agentId)) : undefined

  const provider = resolveProvider(params.model)
  const { apiKey, baseUrl } = await resolveModelCredentials(params.model)
  const skillList = await discoverSkills(params.skillDirs)
  const memory = await storage.getMemory()
  const system = buildSystemPrompt(params.profile, memory, agent?.instructions, skillList)
  const { specs, routes } = provider.supportsTools ? await gatherMcpTools() : { specs: [], routes: new Map<string, ToolRoute>() }

  const history: ChatMessage[] = (await storage.listMessages(params.chatId)).map((m) => ({ role: m.role, content: m.content }))

  const finalText = await streamTurn({ model: params.model, apiKey, baseUrl, system, tools: specs, routes, history }, onDelta)

  await storage.insertMessage(params.chatId, 'assistant', finalText)
  await storage.touchChat(params.chatId)
  await maybeUpdateMemory(params.chatId, params.model)
}

/** "Regenerate": drops the last assistant reply (if any) and re-runs the
 *  same turn from the existing history — no new user message. */
export async function runRegenerate(params: Omit<SendParams, 'content'>, onDelta: (text: string) => void): Promise<void> {
  await storage.deleteLastAssistantMessage(params.chatId)

  const chat = await storage.getChat(params.chatId)
  const agent = chat?.agentId ? await storage.listAgents().then((agents) => agents.find((a) => a.id === chat.agentId)) : undefined

  const provider = resolveProvider(params.model)
  const { apiKey, baseUrl } = await resolveModelCredentials(params.model)
  const skillList = await discoverSkills(params.skillDirs)
  const memory = await storage.getMemory()
  const system = buildSystemPrompt(params.profile, memory, agent?.instructions, skillList)
  const { specs, routes } = provider.supportsTools ? await gatherMcpTools() : { specs: [], routes: new Map<string, ToolRoute>() }

  const history: ChatMessage[] = (await storage.listMessages(params.chatId)).map((m) => ({ role: m.role, content: m.content }))

  const finalText = await streamTurn({ model: params.model, apiKey, baseUrl, system, tools: specs, routes, history }, onDelta)

  await storage.insertMessage(params.chatId, 'assistant', finalText)
  await storage.touchChat(params.chatId)
  await maybeUpdateMemory(params.chatId, params.model)
}

/** Fires a Personalization Memory update every `MEMORY_UPDATE_INTERVAL`
 *  messages in a chat — merges the last interval's worth of turns into the
 *  existing memory via one extra, non-streamed model call. Awaited (not
 *  fire-and-forget): this extension host has no background-job
 *  infrastructure, and a detached async call risks being killed the
 *  moment the command view unmounts right after `runSend`/`runRegenerate`
 *  returns. The added latency lands only on trigger turns. Never throws —
 *  a failed or low-quality memory update must not break the visible
 *  chat reply, which has already been persisted by the time this runs. */
async function maybeUpdateMemory(chatId: string, model: string): Promise<void> {
  try {
    const messages = await storage.listMessages(chatId)
    if (messages.length === 0 || messages.length % MEMORY_UPDATE_INTERVAL !== 0) return

    const currentMemory = await storage.getMemory()
    const recent = messages.slice(-MEMORY_UPDATE_INTERVAL)
    const transcript = recent.map((m) => `${m.role}: ${m.content}`).join('\n')
    const prompt = [
      'You maintain a concise, evolving memory of durable facts and preferences about the user, built up across their conversations with you.',
      currentMemory ? `Existing memory:\n${currentMemory}` : 'No existing memory yet.',
      `Recent conversation turns:\n${transcript}`,
      'Produce the updated memory: merge any new durable facts or preferences into the existing memory (don\'t just append), drop anything no longer relevant, and keep it concise. Output only the updated memory text, with no preamble or commentary.',
    ].join('\n\n')

    const { apiKey, baseUrl } = await resolveModelCredentials(model)
    const updated = await streamTurn(
      { model, apiKey, baseUrl, tools: [], routes: new Map<string, ToolRoute>(), history: [{ role: 'user', content: prompt }] },
      () => {},
    )
    if (updated.trim()) await storage.setMemory(updated.trim())
  } catch {
    // Never let a memory-update failure surface to the caller.
  }
}

/** AI Commands run text-only, with no persisted history and no
 *  skills/MCP tools — matching Raycast's own documented behavior. */
export async function runCommand(prompt: string, model: string, onDelta: (text: string) => void): Promise<string> {
  const { apiKey, baseUrl } = await resolveModelCredentials(model)
  return streamTurn({ model, apiKey, baseUrl, tools: [], routes: new Map(), history: [{ role: 'user', content: prompt }] }, onDelta)
}
