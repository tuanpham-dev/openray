/**
 * Pure helpers for the MCP OAuth flow — port of the non-network parts of
 * `src-tauri/src/application/ai/mcp_oauth.rs`. The interactive flow itself
 * (discovery HTTP calls, the loopback `node:http` server, opening the
 * system browser) lives in `extensions/ai/src/mcp/oauth.ts`, since it
 * needs real I/O; this module is what's testable without a network or a
 * socket.
 *
 * **Unverified (disclosed, matching native):** this flow is written
 * against RFC 7591 (Dynamic Client Registration) / RFC 8414 (discovery)
 * and has never been exercised against a live MCP OAuth server.
 */

import { createHash, randomBytes } from 'node:crypto'

function base64UrlNoPad(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function randomUrlSafeToken(): string {
  return base64UrlNoPad(randomBytes(48))
}

export function pkceChallenge(verifier: string): string {
  return base64UrlNoPad(createHash('sha256').update(verifier).digest())
}

export function originOf(url: string): string {
  const match = url.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/]+)/)
  if (!match) throw new Error('parse: invalid server URL')
  return `${match[1]}://${match[2]}`
}

export function parseQueryString(query: string): Record<string, string> {
  const params: Record<string, string> = {}
  for (const pair of query.split('&')) {
    if (!pair) continue
    const eq = pair.indexOf('=')
    if (eq === -1) continue
    const key = decodeURIComponent(pair.slice(0, eq))
    const value = decodeURIComponent(pair.slice(eq + 1))
    params[key] = value
  }
  return params
}
