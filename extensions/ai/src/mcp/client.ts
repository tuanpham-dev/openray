/**
 * Minimal MCP client — JSON-RPC 2.0 over stdio or HTTP, just enough to
 * list and call tools (`initialize` → `tools/list`/`tools/call`; no
 * resources/prompts support). Port of
 * `src-tauri/src/application/ai/mcp.rs`.
 *
 * **Simplification (disclosed, matching native):** stdio connections are
 * ephemeral — each call spawns a fresh child, initializes it, sends one
 * request, and tears it down, rather than keeping a persistent process.
 */
import { spawn } from 'node:child_process'
import * as readline from 'node:readline'
import { readSseLines } from '../providers/sse'
import type { ToolSpec } from '../providers/types'
import type { McpServerRecord } from '../storage'

export interface McpTool {
  remoteName: string
  spec: ToolSpec
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9]/g, '_')
}

function stdioRoundtrip(server: McpServerRecord, requests: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    if (!server.command) return reject(new Error('parse: stdio server has no command configured'))
    const child = spawn(server.command, server.args ?? [], { env: { ...process.env, ...(server.env ?? {}) }, stdio: ['pipe', 'pipe', 'ignore'] })
    const responses: Record<string, unknown>[] = []
    const pendingRequests = [...requests]
    let settled = false

    const finish = (err: Error | null, value?: Record<string, unknown>[]) => {
      if (settled) return
      settled = true
      child.kill()
      if (err) reject(err)
      else resolve(value!)
    }

    child.on('error', (err) => finish(new Error(`network: failed to launch MCP server '${server.command}': ${err.message}`)))

    const rl = readline.createInterface({ input: child.stdout })
    let awaitingInit = true
    rl.on('line', (line) => {
      if (!line.trim()) return finish(new Error('network: MCP server closed the connection without responding'))
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(line) as Record<string, unknown>
      } catch (err) {
        return finish(new Error(`parse: ${err instanceof Error ? err.message : String(err)}`))
      }
      if (awaitingInit) {
        awaitingInit = false
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
        sendNext()
        return
      }
      responses.push(parsed)
      if (responses.length === requests.length) finish(null, responses)
      else sendNext()
    })

    function sendNext() {
      const next = pendingRequests.shift()
      if (next) child.stdin.write(`${JSON.stringify(next)}\n`)
    }

    const initRequest = { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'openray', version: '0.1.0' } } }
    child.stdin.write(`${JSON.stringify(initRequest)}\n`)
  })
}

async function httpRoundtrip(server: McpServerRecord, bearer: string | undefined, request: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!server.url) throw new Error('parse: HTTP server has no URL configured')
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  if (bearer) headers.authorization = `Bearer ${bearer}`
  for (const [key, value] of Object.entries(server.headers ?? {})) headers[key] = value

  const response = await fetch(server.url, { method: 'POST', headers, body: JSON.stringify(request) })
  if (!response.ok) throw new Error(`network: ${response.status} ${response.statusText}`)
  const contentType = response.headers.get('content-type') ?? ''

  if (contentType.includes('text/event-stream')) {
    if (!response.body) throw new Error('parse: no response body')
    let result: Record<string, unknown> | undefined
    await readSseLines(response.body, (data) => {
      if (result) return
      try {
        const value = JSON.parse(data) as Record<string, unknown>
        if (value.result !== undefined || value.error !== undefined) result = value
      } catch {
        // ignore malformed chunks
      }
    })
    if (!result) throw new Error('parse: no JSON-RPC response in the SSE stream')
    return result
  }
  return (await response.json()) as Record<string, unknown>
}

/** Lists a server's tools, namespaced `mcp_<server-id>_<tool-name>` so the
 *  engine can route a model's tool call back to the right server. */
export async function listTools(server: McpServerRecord, bearer: string | undefined): Promise<McpTool[]> {
  const request = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }
  const response =
    server.transport === 'stdio' ? (await stdioRoundtrip(server, [request]))[0] : await httpRoundtrip(server, bearer, request)
  if (!response) throw new Error('parse: no response')

  const tools = ((response.result as Record<string, unknown> | undefined)?.tools as Record<string, unknown>[] | undefined) ?? []
  const out: McpTool[] = []
  for (const tool of tools) {
    const name = tool.name
    if (typeof name !== 'string') continue
    const description = typeof tool.description === 'string' ? tool.description : ''
    const inputSchema = tool.inputSchema ?? { type: 'object' }
    out.push({ remoteName: name, spec: { name: `mcp_${sanitize(server.id)}_${sanitize(name)}`, description, inputSchema } })
  }
  return out
}

export async function callTool(server: McpServerRecord, bearer: string | undefined, remoteToolName: string, arguments_: unknown): Promise<string> {
  const request = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: remoteToolName, arguments: arguments_ } }
  const response =
    server.transport === 'stdio' ? (await stdioRoundtrip(server, [request]))[0] : await httpRoundtrip(server, bearer, request)
  if (!response) throw new Error('parse: no response')

  const error = response.error as Record<string, unknown> | undefined
  if (error) throw new Error(`network: ${typeof error.message === 'string' ? error.message : 'tool call failed'}`)

  const content = ((response.result as Record<string, unknown> | undefined)?.content as Record<string, unknown>[] | undefined) ?? []
  const text = content
    .map((c) => (typeof c.text === 'string' ? c.text : ''))
    .filter(Boolean)
    .join('\n')
  return text || JSON.stringify(response.result ?? '')
}
