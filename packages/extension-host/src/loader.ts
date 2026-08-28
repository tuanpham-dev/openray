import type { JsonValue } from '@openray/protocol'
import type { RpcDispatcher } from './rpc'
import { installLocalDirectory, installStoreSlug, uninstallExtension } from './builder'
import { developList, developStart, developStop } from './dev'
import { installArchive, packExtension } from './pack'
import { downloadArchive, fetchCatalog } from './registry'

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

interface DevelopStartParams {
  path: string
}

interface DevelopStopParams {
  id: string
}

interface InstallArchiveParams {
  path: string
  extensionsRoot: string
}

interface PackParams {
  path: string
  outDir: string
  sourceCommit?: string
}

interface FetchCatalogParams {
  url: string
  cacheDir: string
}

interface InstallFromRegistryParams {
  fileUrl: string
  sha256?: string
  extensionsRoot: string
}

function asRecord(params: unknown): Record<string, unknown> {
  if (params && typeof params === 'object') return params as Record<string, unknown>
  throw new Error('expected an object params payload')
}

/**
 * Registers the host-level RPC methods (liveness + identification,
 * extension install/uninstall, and dev mode). Real extension
 * loading/rendering (T20-T22) is added here later.
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

  // Dev mode: unlike the install methods above, this builds the author's
  // own directory in place and leaves a watcher behind. Rebuilds arrive at
  // the platform asynchronously as `extension.devBuild` notifications —
  // there's no request to respond to by the time a save happens, which is
  // exactly why this is a notification rather than a call/response.
  dispatcher.register('extension.developStart', async (params) => {
    const { path } = asRecord(params) as unknown as DevelopStartParams
    const result = await developStart(path, (build) => {
      dispatcher.notify('extension.devBuild', build as unknown as JsonValue)
    })
    return result as unknown as JsonValue
  })

  dispatcher.register('extension.developStop', (params) => {
    const { id } = asRecord(params) as unknown as DevelopStopParams
    return { stopped: developStop(id) }
  })

  dispatcher.register('extension.developList', () => developList() as unknown as JsonValue)

  // Archive install — no npm, no git, no esbuild: a `.orx` already carries
  // built bundles, so this is unzip + validate + swap.
  dispatcher.register('extension.installArchive', async (params) => {
    const { path, extensionsRoot } = asRecord(params) as unknown as InstallArchiveParams
    const result = await installArchive(path, extensionsRoot)
    return {
      id: result.id,
      manifest: result.manifest,
      dir: result.dir,
      version: result.version,
      buildErrors: [],
    } as unknown as JsonValue
  })

  dispatcher.register('registry.fetchCatalog', async (params) => {
    const { url, cacheDir } = asRecord(params) as unknown as FetchCatalogParams
    return (await fetchCatalog(url, cacheDir)) as unknown as JsonValue
  })

  // Download + verify + install, as one call: the digest check only means
  // anything if nothing can substitute the file between the two steps.
  dispatcher.register('registry.install', async (params) => {
    const { fileUrl, sha256, extensionsRoot } = asRecord(params) as unknown as InstallFromRegistryParams
    const archivePath = await downloadArchive(fileUrl, sha256)
    const result = await installArchive(archivePath, extensionsRoot)
    return {
      id: result.id,
      manifest: result.manifest,
      dir: result.dir,
      version: result.version,
      buildErrors: [],
    } as unknown as JsonValue
  })

  // The other half of the same format, exposed so a registry's tooling can
  // pack through the very same code path that installs.
  dispatcher.register('extension.pack', async (params) => {
    const { path, outDir, sourceCommit } = asRecord(params) as unknown as PackParams
    const packed = await packExtension(path, outDir, sourceCommit ? { sourceCommit } : {})
    return packed as unknown as JsonValue
  })
}
