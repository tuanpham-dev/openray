/**
 * MCP OAuth: Dynamic Client Registration (RFC 7591) + authorization-code
 * + PKCE for servers with no pre-registered client, or Static
 * (pre-registered `client_id`/`client_secret`) for servers that already
 * have one. Discovery follows RFC 8414. Port of
 * `src-tauri/src/application/ai/mcp_oauth.rs`.
 *
 * **Unverified (disclosed, matching native):** never exercised against a
 * live MCP OAuth server. A discovery or registration mismatch will
 * surface as a thrown error, not a hang — every step is one bounded HTTP
 * call, except the loopback accept itself (bounded by the user actually
 * completing the browser flow).
 *
 * The loopback server uses `node:http` (built directly on `node:net`,
 * matching the plan's "MCP OAuth loopback via Node net" — `http` parses
 * the redirect GET's request line/query string for us instead of hand-
 * rolling byte parsing the way the native `TcpListener` version does).
 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { originOf, parseQueryString, pkceChallenge, randomUrlSafeToken } from '@openray/ai-core'
import type { McpServerRecord } from '../storage'

interface Endpoints {
  authorizationEndpoint: string
  tokenEndpoint: string
  registrationEndpoint?: string
}

async function discover(serverUrl: string): Promise<Endpoints> {
  const origin = originOf(serverUrl)
  const response = await fetch(`${origin}/.well-known/oauth-authorization-server`)
  if (!response.ok) throw new Error(`network: OAuth discovery failed: ${response.status} ${response.statusText}`)
  const body = (await response.json()) as Record<string, unknown>
  const authorizationEndpoint = body.authorization_endpoint
  const tokenEndpoint = body.token_endpoint
  if (typeof authorizationEndpoint !== 'string') throw new Error('parse: discovery response missing authorization_endpoint')
  if (typeof tokenEndpoint !== 'string') throw new Error('parse: discovery response missing token_endpoint')
  return { authorizationEndpoint, tokenEndpoint, registrationEndpoint: typeof body.registration_endpoint === 'string' ? body.registration_endpoint : undefined }
}

/** Just the token endpoint — used to refresh an expired token without
 *  re-running the full interactive flow. */
export async function discoverTokenEndpoint(serverUrl: string): Promise<string> {
  return (await discover(serverUrl)).tokenEndpoint
}

async function registerDynamicClient(registrationEndpoint: string, redirectUri: string): Promise<string> {
  const response = await fetch(registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: 'openray',
    }),
  })
  if (!response.ok) throw new Error(`network: dynamic client registration failed: ${response.status} ${response.statusText}`)
  const body = (await response.json()) as Record<string, unknown>
  if (typeof body.client_id !== 'string') throw new Error('parse: registration response missing client_id')
  return body.client_id
}

export interface OAuthResult {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
}

/** Runs the entire interactive flow — discovery, (optional) dynamic
 *  registration, opening the system browser, waiting on the loopback
 *  redirect, and the final token exchange. `clientSecret` (a Static
 *  server's confidential secret, if any) is sent as HTTP Basic auth on
 *  the token exchange when present. */
export async function runOAuthFlow(openBrowser: (url: string) => Promise<void>, server: McpServerRecord, clientSecret: string | undefined): Promise<OAuthResult> {
  if (!server.url) throw new Error('parse: server has no URL configured')
  const endpoints = await discover(server.url)

  let port: number | undefined
  let resolveQuery: (query: string) => void = () => {}
  const queryPromise = new Promise<string>((resolve) => {
    resolveQuery = resolve
  })
  const httpServer = createServer((req, res) => {
    const query = req.url?.split('?')[1] ?? ''
    const body = '<html><body>Authorization complete — you can close this tab.</body></html>'
    res.writeHead(200, { 'content-type': 'text/html', 'content-length': Buffer.byteLength(body) })
    res.end(body)
    resolveQuery(query)
  })
  try {
    port = await new Promise<number>((resolve, reject) => {
      httpServer.on('error', reject)
      httpServer.listen(0, '127.0.0.1', () => resolve((httpServer.address() as AddressInfo).port))
    })
    const redirectUri = `http://127.0.0.1:${port}/callback`

    const isStatic = server.oauthType === 'static'
    let clientId: string
    if (isStatic) {
      if (!server.oauthClientId) throw new Error('parse: static OAuth server has no client_id configured')
      clientId = server.oauthClientId
    } else {
      if (!endpoints.registrationEndpoint) throw new Error('parse: server has no registration_endpoint for dynamic client registration')
      clientId = await registerDynamicClient(endpoints.registrationEndpoint, redirectUri)
    }

    const verifier = randomUrlSafeToken()
    const challenge = pkceChallenge(verifier)
    const state = randomUrlSafeToken()
    const scopes = server.oauthScopes ?? ''

    let authUrl = `${endpoints.authorizationEndpoint}?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${challenge}&code_challenge_method=S256&state=${state}`
    if (scopes) authUrl += `&scope=${encodeURIComponent(scopes)}`

    await openBrowser(authUrl)

    const query = await queryPromise
    const params = parseQueryString(query)

    if (params.error) throw new Error(`auth: authorization was denied (${params.error})`)
    const code = params.code
    if (!code) throw new Error('parse: redirect had no authorization code')
    if (params.state !== state) throw new Error('auth: OAuth state mismatch — possible interference')

    const tokenHeaders: Record<string, string> = { 'content-type': 'application/json' }
    if (clientSecret) tokenHeaders.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`

    const tokenResponse = await fetch(endpoints.tokenEndpoint, {
      method: 'POST',
      headers: tokenHeaders,
      body: JSON.stringify({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier }),
    })
    if (!tokenResponse.ok) throw new Error(`network: token exchange failed: ${tokenResponse.status} ${tokenResponse.statusText}`)
    const body = (await tokenResponse.json()) as Record<string, unknown>
    if (typeof body.access_token !== 'string') throw new Error('parse: token response missing access_token')
    const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : undefined
    return {
      accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
      expiresAt: expiresIn !== undefined ? Math.floor(Date.now() / 1000) + expiresIn : undefined,
    }
  } finally {
    httpServer.close()
  }
}

/** Exchanges a refresh token for a new access token. */
export async function refreshAccessToken(tokenEndpoint: string, clientId: string, refreshToken: string): Promise<OAuthResult> {
  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }),
  })
  if (!response.ok) throw new Error(`network: token refresh failed: ${response.status} ${response.statusText}`)
  const body = (await response.json()) as Record<string, unknown>
  if (typeof body.access_token !== 'string') throw new Error('parse: refresh response missing access_token')
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : undefined
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : refreshToken,
    expiresAt: expiresIn !== undefined ? Math.floor(Date.now() / 1000) + expiresIn : undefined,
  }
}
