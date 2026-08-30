import { getHostBridge } from '../bridge'

/**
 * Registry access, for the Store extension.
 *
 * All of this is platform-owned state — which registries the user trusts,
 * what's installed, what an install would replace — so it comes through the
 * bridge rather than an extension reaching for the filesystem or the
 * network itself. Installing in particular has to be the platform's
 * decision: it enforces the built-in and dev-extension rules and records
 * where the extension came from, which is what later makes it
 * auto-updatable.
 */

export interface RegistrySource {
  url: string
  name: string | null
  enabled: boolean
  autoUpdate: boolean
  addedAt: number
}

export interface CatalogEntry {
  name: string
  title: string
  description?: string
  author?: string
  version?: string
  apiVersion?: string
  file: string
  sha256?: string
  icon?: string
  readme?: string
  /** Screenshot URLs, already resolved against the registry base. */
  screenshots?: string[]
  categories?: string[]
  platforms?: string[]
  /** The commands the extension contributes, from its manifest. */
  commands?: { name: string; title: string; description?: string }[]
}

export interface Catalog {
  formatVersion: number
  name?: string
  description?: string
  extensions: CatalogEntry[]
  sourceUrl: string
  /** True when this came from the on-disk cache — the registry was
   *  unreachable, or answered 304. Worth showing as "offline". */
  fromCache: boolean
}

export interface InstalledExtensionRow {
  id: string
  title: string
  version: string | null
  sourceUrl: string | null
  source: string
  enabled: boolean
}

/** What installing an entry would do to an extension already under that id. */
export type InstallImpact =
  | { kind: 'fresh' }
  | { kind: 'update'; from: string | null }
  | { kind: 'replace'; currentSource: string | null }
  | { kind: 'blocked'; reason: string }

/** The registries the user has added and left enabled. */
export async function listRegistrySources(): Promise<RegistrySource[]> {
  return ((await getHostBridge().call('host.registry.sources')) ?? []) as RegistrySource[]
}

/** One registry's catalog. Throws if it can't be read and nothing is cached. */
export async function fetchCatalog(url: string): Promise<Catalog> {
  return (await getHostBridge().call('host.registry.catalog', { url })) as unknown as Catalog
}

export async function listInstalledExtensions(): Promise<InstalledExtensionRow[]> {
  return ((await getHostBridge().call('host.registry.installed')) ?? []) as InstalledExtensionRow[]
}

/**
 * Ask before installing: whether this would be a fresh install, an update,
 * a cross-registry replacement (which shares the extension's stored data
 * and should be confirmed), or something refused outright.
 */
export async function classifyInstall(id: string, sourceUrl: string): Promise<InstallImpact> {
  return (await getHostBridge().call('host.registry.classify', { id, sourceUrl })) as unknown as InstallImpact
}

/** Downloads, verifies the catalog digest, unpacks, and registers. */
export async function installFromRegistry(options: {
  sourceUrl: string
  fileUrl: string
  sha256?: string
}): Promise<{ id: string; version: string | null }> {
  return (await getHostBridge().call('host.registry.install', {
    sourceUrl: options.sourceUrl,
    fileUrl: options.fileUrl,
    ...(options.sha256 ? { sha256: options.sha256 } : {}),
  })) as unknown as { id: string; version: string | null }
}

/** Removes an installed extension. Refuses built-ins and dev extensions. */
export async function uninstallExtension(id: string): Promise<void> {
  await getHostBridge().call('host.registry.uninstall', { id })
}
