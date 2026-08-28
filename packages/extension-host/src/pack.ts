import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { unzip, zip, type Zippable } from 'fflate'
import type { ExtensionManifest } from '@openray/protocol'
import { buildCommand, buildExtensionInPlace, readManifest, readRawManifest } from './builder'
import { missingApis } from './capabilities'
import { log } from './rpc'

/**
 * The `.orx` container: a zip whose entries all sit under a top-level
 * `extension/` directory. Same layout as the `.tsix` format this was
 * modelled on, which keeps unpacking to "strip one path segment" and makes
 * the archive inspectable with any unzip tool.
 */
export const ORX_ROOT = 'extension'

/**
 * Bumped only when the *container* changes in a way an older host can't
 * read (a moved directory, a renamed metadata file). Additive fields in
 * `openray.pack.json` don't move it — an old host ignores what it doesn't
 * know.
 */
const ORX_FORMAT_VERSION = 1

/** Metadata generated at pack time, carried inside the archive. */
interface PackMetadata {
  formatVersion: number
  /** api-shim's version when packed. Display metadata: compatibility is
   *  decided by {@link usedApis}, not by comparing this. */
  apiVersion: string
  usedApis: string[]
  packedAt: string
  sourceCommit?: string
}

export interface PackedExtension {
  id: string
  version: string
  file: string
  sha256: string
  usedApis: string[]
  buildErrors: string[]
}

/** Files never worth carrying into an archive. */
const EXCLUDED_SEGMENTS = new Set(['node_modules', '.git', '.DS_Store'])

/** Anything here means the extension can't run from a portable bundle. */
const NATIVE_ARTIFACT = /\.(node|dylib|so|dll)$/i

async function apiShimVersion(): Promise<string> {
  try {
    const raw = await readFile(join(__dirname, '..', '..', 'api-shim', 'package.json'), 'utf-8')
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * Walks `dir`, returning paths relative to it. Skips the excluded segments
 * above; follows nothing symlinked out of the tree (`cp`'s own behavior is
 * not involved — this reads the tree directly).
 */
async function walk(dir: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    if (EXCLUDED_SEGMENTS.has(entry.name)) continue
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      files.push(...(await walk(join(dir, entry.name), relativePath)))
    } else if (entry.isFile()) {
      files.push(relativePath)
    }
  }
  return files
}

/**
 * Refuses an extension whose dependency tree can't travel: a native addon
 * is compiled for one platform and ABI, and an install script means the
 * archive would need a toolchain on the installing machine — the very
 * thing prebuilt archives exist to avoid. Caught here, at pack time, so it
 * fails in the packer's own CI rather than on a user's machine.
 */
export async function findUnpackableDependencies(extensionDir: string): Promise<string[]> {
  const problems: string[] = []
  const modulesDir = join(extensionDir, 'node_modules')
  if (!existsSync(modulesDir)) return problems

  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await visit(join(dir, entry.name), depth + 1)
      } else if (entry.isFile() && NATIVE_ARTIFACT.test(entry.name)) {
        problems.push(`native binary ${relative(extensionDir, join(dir, entry.name))}`)
      }
    }
  }
  await visit(modulesDir, 0)

  const manifest = await readRawManifest(extensionDir)
  const scripts = (manifest.scripts ?? {}) as Record<string, unknown>
  for (const hook of ['preinstall', 'install', 'postinstall']) {
    if (typeof scripts[hook] === 'string') problems.push(`"${hook}" install script`)
  }
  return problems
}

/**
 * Builds an extension and writes `<name>-<version>.orx` into `outDir`.
 *
 * Everything that could make an archive fail on someone else's machine is
 * checked *here*: a build error, an API the local shim doesn't provide, a
 * native dependency, or a license file the archive would silently drop
 * while redistributing someone else's code.
 */
export async function packExtension(
  extensionDir: string,
  outDir: string,
  options: { sourceCommit?: string; packedAt?: string } = {},
): Promise<PackedExtension> {
  const built = await buildExtensionInPlace(extensionDir)
  if (built.buildErrors.length > 0) {
    throw new Error(`${built.id} did not build cleanly:\n  ${built.buildErrors.join('\n  ')}`)
  }

  // A second pass over the same commands, this time collecting which API
  // names they import (`buildCommand`'s optional third argument). Cheap —
  // esbuild is re-running over an already-warm tree — and it keeps the
  // normal build path free of pack-only concerns.
  const usedApis = new Set<string>()
  for (const command of built.manifest.commands) {
    await buildCommand(extensionDir, command.name, usedApis)
  }

  const missing = missingApis([...usedApis])
  if (missing.length > 0) {
    throw new Error(`${built.id} uses APIs this build doesn't provide: ${missing.join(', ')}`)
  }

  const unpackable = await findUnpackableDependencies(extensionDir)
  if (unpackable.length > 0) {
    throw new Error(`${built.id} can't be packed portably: ${unpackable.join('; ')}`)
  }

  const files = await walk(extensionDir)
  const missingAttribution = await findMissingAttribution(extensionDir, files)
  if (missingAttribution) throw new Error(`${built.id} ${missingAttribution}`)

  const raw = await readRawManifest(extensionDir)
  const version = typeof raw.version === 'string' ? raw.version : '0.0.0'
  const metadata: PackMetadata = {
    formatVersion: ORX_FORMAT_VERSION,
    apiVersion: await apiShimVersion(),
    usedApis: [...usedApis].sort(),
    packedAt: options.packedAt ?? new Date().toISOString(),
    ...(options.sourceCommit ? { sourceCommit: options.sourceCommit } : {}),
  }

  const entries: Zippable = {}
  for (const file of files) {
    entries[`${ORX_ROOT}/${file}`] = new Uint8Array(await readFile(join(extensionDir, file)))
  }
  entries[`${ORX_ROOT}/openray.pack.json`] = new TextEncoder().encode(JSON.stringify(metadata, null, 2))

  const archive = await zipAsync(entries)
  await mkdir(outDir, { recursive: true })
  const fileName = `${built.id}-${version}.orx`

  // Written to a unique name inside `outDir` and renamed into place: a
  // same-directory rename is atomic, so two concurrent packs can't
  // interleave into one half-written archive, and staging outside `outDir`
  // would risk a cross-filesystem rename.
  const staged = join(outDir, `.tmp-${process.pid}-${fileName}`)
  await writeFile(staged, archive)
  await rename(staged, join(outDir, fileName))

  return {
    id: built.id,
    version,
    file: fileName,
    sha256: createHash('sha256').update(archive).digest('hex'),
    usedApis: metadata.usedApis,
    buildErrors: built.buildErrors,
  }
}

const LICENSE_FILE = /^LICENSE(\.[\w.]+)?$/i

/**
 * Packing redistributes other people's code — not by copying
 * `node_modules` (that is excluded from the archive) but because esbuild
 * *inlines* every dependency into the command bundles. An MIT or
 * Apache-licensed dependency travelling inside `.openray/build/index.js`
 * carries the same attribution obligation it would in any other
 * distributed binary, and a registry republishing third-party extensions
 * is exactly where that gets forgotten.
 *
 * Workspace-linked dependencies (`workspace:`, `link:`, `file:`) don't
 * count: they're first-party code from the same repository, covered by the
 * repository's own license rather than needing per-extension attribution.
 *
 * Returns the problem as a sentence, or `null` when there's nothing to
 * report.
 */
async function findMissingAttribution(extensionDir: string, packedFiles: string[]): Promise<string | null> {
  const hasLicense = packedFiles.some((file) => LICENSE_FILE.test(file))
  if (hasLicense) return null

  const manifest = await readRawManifest(extensionDir)
  const declared = (manifest.dependencies ?? {}) as Record<string, unknown>
  const thirdParty = Object.entries(declared)
    .filter(([, version]) => typeof version !== 'string' || !/^(workspace|link|file):/.test(version))
    .map(([name]) => name)
  if (thirdParty.length === 0) return null

  return `inlines third-party code (${thirdParty.join(', ')}) but ships no LICENSE file`
}

export interface ArchiveInstallResult {
  id: string
  manifest: ExtensionManifest
  dir: string
  version: string
}

/**
 * Installs a `.orx` — unzip, validate, swap into place. No npm, no git, no
 * esbuild: the archive already carries built bundles, which is the whole
 * reason this path exists.
 *
 * The swap is staged. `installFromDirectory`'s long-standing hazard is that
 * it deletes the destination *before* the new copy is known good, so a
 * failed reinstall leaves nothing behind; here the existing directory is
 * moved aside and only removed once the new one is in place, and restored
 * if anything goes wrong.
 */
export async function installArchive(archivePath: string, extensionsRoot: string): Promise<ArchiveInstallResult> {
  const bytes = new Uint8Array(await readFile(archivePath))
  const unpacked = await unzipAsync(bytes)

  const workDir = await mkdtemp(join(tmpdir(), 'openray-orx-'))
  try {
    let sawRootedEntry = false
    for (const [name, content] of Object.entries(unpacked)) {
      if (!name.startsWith(`${ORX_ROOT}/`)) continue
      sawRootedEntry = true
      const relativePath = name.slice(ORX_ROOT.length + 1)
      if (!relativePath || relativePath.endsWith('/')) continue
      // Zip entries are attacker-controlled paths: refuse anything that
      // would escape the staging directory (the "zip slip" traversal).
      const target = join(workDir, relativePath)
      if (!target.startsWith(workDir + sep)) {
        throw new Error(`archive entry "${name}" escapes the extension directory`)
      }
      await mkdir(join(target, '..'), { recursive: true })
      await writeFile(target, content)
    }
    if (!sawRootedEntry) {
      throw new Error(`${archivePath} is not an OpenRay extension archive (no "${ORX_ROOT}/" entries)`)
    }

    const metadata = await readPackMetadata(workDir)
    if (metadata.formatVersion > ORX_FORMAT_VERSION) {
      throw new Error(`this archive needs a newer version of OpenRay (format ${metadata.formatVersion})`)
    }

    const manifest = await readManifest(workDir)
    const missing = missingApis(metadata.usedApis)
    if (missing.length > 0) {
      throw new Error(`${manifest.name} needs APIs this version of OpenRay doesn't provide: ${missing.join(', ')}`)
    }
    if (!existsSync(join(workDir, '.openray', 'build'))) {
      throw new Error(`${manifest.name} carries no built commands — it was packed incorrectly`)
    }

    await mkdir(extensionsRoot, { recursive: true })
    const destDir = join(extensionsRoot, manifest.name)
    const backupDir = `${destDir}.replacing-${process.pid}`
    const hadPrevious = existsSync(destDir)
    if (hadPrevious) await rename(destDir, backupDir)
    try {
      // Copied rather than renamed: the temp dir and the extensions root
      // are routinely on different filesystems, where rename fails EXDEV.
      await cp(workDir, destDir, { recursive: true })
    } catch (error) {
      if (hadPrevious) await rename(backupDir, destDir)
      throw error
    }
    if (hadPrevious) await rm(backupDir, { recursive: true, force: true })

    const raw = await readRawManifest(destDir)
    const version = typeof raw.version === 'string' ? raw.version : '0.0.0'
    log(`installed ${manifest.name}@${version} from ${archivePath}`)
    return { id: manifest.name, manifest, dir: destDir, version }
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

async function readPackMetadata(dir: string): Promise<PackMetadata> {
  const path = join(dir, 'openray.pack.json')
  if (!existsSync(path)) {
    throw new Error('archive is missing openray.pack.json')
  }
  const parsed = JSON.parse(await readFile(path, 'utf-8')) as Partial<PackMetadata>
  return {
    formatVersion: typeof parsed.formatVersion === 'number' ? parsed.formatVersion : 0,
    apiVersion: typeof parsed.apiVersion === 'string' ? parsed.apiVersion : '0.0.0',
    usedApis: Array.isArray(parsed.usedApis) ? parsed.usedApis.filter((name): name is string => typeof name === 'string') : [],
    packedAt: typeof parsed.packedAt === 'string' ? parsed.packedAt : '',
    ...(typeof parsed.sourceCommit === 'string' ? { sourceCommit: parsed.sourceCommit } : {}),
  }
}

function zipAsync(entries: Zippable): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    zip(entries, { level: 6 }, (error, data) => (error ? reject(error) : resolve(data)))
  })
}

function unzipAsync(bytes: Uint8Array): Promise<Record<string, Uint8Array>> {
  return new Promise((resolve, reject) => {
    unzip(bytes, (error, data) => (error ? reject(error) : resolve(data)))
  })
}
