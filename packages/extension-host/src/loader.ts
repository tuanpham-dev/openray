import type { JsonValue } from '@openray/protocol'
import type { RpcDispatcher } from './rpc'
import { installLocalDirectory, installStoreSlug, uninstallExtension } from './builder'

interface InstallLocalParams {
  path: string
  extensionsRoot: string
}

interface InstallSlugParams {
  slug: string
  extensionsRoot: string
}

interface UninstallParams {
  id: string
  extensionsRoot: string
}

function asRecord(params: unknown): Record<string, unknown> {
  if (params && typeof params === 'object') return params as Record<string, unknown>
  throw new Error('expected an object params payload')
}

/**
 * Registers the host-level RPC methods (liveness + identification, and
 * extension install/uninstall). Real extension loading/rendering (T20-T22)
 * is added here later.
 */
export function registerHostMethods(dispatcher: RpcDispatcher): void {
  dispatcher.register('host.hello', () => ({
    message: 'hello from extension host',
    pid: process.pid,
    nodeVersion: process.version,
  }))

  dispatcher.register('host.ping', () => ({ pong: true, ts: Date.now() }))

  dispatcher.register('extension.installLocal', async (params) => {
    const { path, extensionsRoot } = asRecord(params) as unknown as InstallLocalParams
    const result = await installLocalDirectory(path, extensionsRoot)
    return { id: result.id, manifest: result.manifest, dir: result.dir, buildErrors: result.buildErrors } as unknown as JsonValue
  })

  dispatcher.register('extension.installStoreSlug', async (params) => {
    const { slug, extensionsRoot } = asRecord(params) as unknown as InstallSlugParams
    const result = await installStoreSlug(slug, extensionsRoot)
    return { id: result.id, manifest: result.manifest, dir: result.dir, buildErrors: result.buildErrors } as unknown as JsonValue
  })

  dispatcher.register('extension.uninstall', async (params) => {
    const { id, extensionsRoot } = asRecord(params) as unknown as UninstallParams
    await uninstallExtension(extensionsRoot, id)
    return { removed: true }
  })
}
