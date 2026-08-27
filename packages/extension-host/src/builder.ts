import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, mkdir, cp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import type { ExtensionManifest } from '@openray/protocol'
import { log } from './rpc'

const execFileAsync = promisify(execFile)
const requireFromHere = createRequire(__filename)

// __dirname resolves to dist/ at runtime (esbuild injects a real CJS
// __dirname for the bundled host.cjs). packages/api-shim is a sibling of
// packages/extension-host, so this walks dist -> extension-host -> packages
// -> api-shim/src. Dev-mode only, matching the same relative-path
// assumption process.rs makes for host.cjs itself; T24 packaging carries
// api-shim's source alongside the bundle for production.
const apiShimSrcDir = join(__dirname, '..', '..', 'api-shim', 'src')

/**
 * Real Raycast extensions generally don't declare `react` themselves — it
 * comes transitively from the real `@raycast/api` package (confirmed
 * against 3 real extensions in the T19b spike, none of which list `react`
 * in their own package.json). Since `@raycast/api` is aliased to our own
 * local shim rather than a real npm package, that transitive supply has to
 * come from somewhere else: alias the bare `react`/jsx-runtime specifiers
 * to api-shim's own installed copy. This also solves a second problem for
 * extensions that *do* declare their own react: aliasing forces every
 * import within one bundle (the extension's own code, react-reconciler,
 * and our component library) onto the exact same resolved file, which is
 * required for hooks to work — React's dispatcher is a module-level
 * singleton, and two separate copies of `react` in one process breaks it
 * with an "Invalid hook call" error that has nothing to do with the code
 * that's actually wrong.
 */
function resolveApiShimReactPaths(): Record<string, string> {
  const resolve = (specifier: string) => requireFromHere.resolve(specifier, { paths: [apiShimSrcDir] })
  return {
    react: resolve('react'),
    'react/jsx-runtime': resolve('react/jsx-runtime'),
    'react/jsx-dev-runtime': resolve('react/jsx-dev-runtime'),
  }
}

export interface InstalledExtension {
  id: string
  manifest: ExtensionManifest
  dir: string
  buildErrors: string[]
}

/** Exported for `scripts/build-builtin-extensions.mjs` (T12) — first-party
 * extensions under `extensions/` are pnpm workspace members (deps already
 * resolved by the root install) built in place, unlike `installFromDirectory`'s
 * copy+`npm install`+build flow for user-installed extensions. */
export async function readManifest(extensionDir: string): Promise<ExtensionManifest> {
  const raw = await readFile(join(extensionDir, 'package.json'), 'utf-8')
  const pkg = JSON.parse(raw) as Record<string, unknown>

  if (typeof pkg.name !== 'string' || !Array.isArray(pkg.commands)) {
    throw new Error(`${extensionDir}/package.json is not a valid Raycast extension manifest`)
  }

  const manifest: ExtensionManifest = {
    name: pkg.name,
    title: typeof pkg.title === 'string' ? pkg.title : pkg.name,
    commands: pkg.commands as ExtensionManifest['commands'],
  }
  if (typeof pkg.description === 'string') manifest.description = pkg.description
  if (typeof pkg.icon === 'string') manifest.icon = pkg.icon
  if (typeof pkg.author === 'string') manifest.author = pkg.author
  if (Array.isArray(pkg.categories)) manifest.categories = pkg.categories as string[]
  if (Array.isArray(pkg.preferences)) manifest.preferences = pkg.preferences as NonNullable<ExtensionManifest['preferences']>
  return manifest
}

async function npmInstall(extensionDir: string): Promise<void> {
  log(`npm install in ${extensionDir}`)
  await execFileAsync('npm', ['install', '--no-audit', '--no-fund'], { cwd: extensionDir, maxBuffer: 1024 * 1024 * 32 })
}

/**
 * Bundles one command entry point, aliasing @raycast/api, @raycast/utils
 * (and their @openray/* equivalents),
 * and react (see resolveApiShimReactAliases) to our shim. Non-fatal on
 * failure — a command whose bundle fails (an unimplemented API, an
 * unresolvable import) still gets registered so it appears in search;
 * running it surfaces the real error instead of silently vanishing.
 */
export async function buildCommand(extensionDir: string, commandName: string): Promise<string | null> {
  const entryCandidates = ['tsx', 'ts', 'jsx', 'js'].map((ext) => join(extensionDir, 'src', `${commandName}.${ext}`))
  const entry = entryCandidates.find((path) => existsSync(path))
  if (!entry) return `no source file found for command "${commandName}"`

  const outDir = join(extensionDir, '.openray', 'build')
  await mkdir(outDir, { recursive: true })

  const reactPaths = resolveApiShimReactPaths()

  try {
    await build({
      entryPoints: [entry],
      outfile: join(outDir, `${commandName}.js`),
      bundle: true,
      platform: 'node',
      target: 'node20',
      format: 'cjs',
      logLevel: 'silent',
      // Real Raycast extensions don't import React explicitly — they rely
      // on the automatic JSX runtime (`react/jsx-runtime`'s `jsx`/`jsxs`,
      // not a bare `React.createElement` reference needing `React` in
      // scope). esbuild defaults to the *classic* transform, which does
      // need that binding — every extension author would otherwise hit a
      // `ReferenceError: React is not defined` the moment their command
      // returns JSX (confirmed empirically: T12's own pipeline-fixture
      // extension hit exactly this before this option was added).
      // `reactPaths` already aliases `react/jsx-runtime`/
      // `jsx-dev-runtime` for exactly this — this was the missing half.
      jsx: 'automatic',
      alias: {
        '@raycast/api': join(apiShimSrcDir, 'index.cts'),
        '@raycast/utils': join(apiShimSrcDir, 'utils.cts'),
        // The same compat surface under OpenRay's own name, so an extension
        // can be written against either spelling. These resolve to the very
        // same modules as the `@raycast/*` entries above — deliberately not
        // a second, divergent API.
        '@openray/api': join(apiShimSrcDir, 'index.cts'),
        '@openray/utils': join(apiShimSrcDir, 'utils.cts'),
        // OpenRay's own extras (T12) — never mutates the compat surface
        // above, kept as a genuinely separate import.
        '@openray/extras': join(apiShimSrcDir, 'openray.cts'),
        ...reactPaths,
      },
      // react (and its jsx-runtimes) must be a real shared runtime
      // dependency, not inlined per-bundle: T22's driver process mounts
      // this compiled command file through react-reconciler from a
      // *separate* bundle, and React's hook dispatcher is a module-level
      // singleton — two inlined copies (one here, one in the driver) look
      // exactly like the "two React copies" bug despite both ultimately
      // reading the same source file, because bundling copies the code
      // rather than sharing the module instance. Everything else
      // (@raycast/api's component library, @raycast/utils) is fine to
      // inline fresh per command — only react's singleton needs sharing.
      //
      // Externalizing by the bare specifier ("react") does NOT work here:
      // esbuild's `external` matches against the *original* import
      // specifier, not the alias target, so an aliased-to-an-absolute-path
      // import silently stays inlined even when its bare name is listed in
      // `external` — confirmed empirically (11kb of inlined React showed
      // up in the output with zero warning). Listing the resolved absolute
      // paths themselves in `external` is what actually works.
      external: Object.values(reactPaths),
    })
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

async function installFromDirectory(sourceDir: string, extensionsRoot: string): Promise<InstalledExtension> {
  const probeManifest = await readManifest(sourceDir)
  const destDir = join(extensionsRoot, probeManifest.name)

  await mkdir(extensionsRoot, { recursive: true })
  await rm(destDir, { recursive: true, force: true })
  await cp(sourceDir, destDir, {
    recursive: true,
    filter: (src) => {
      const segments = src.split(sep)
      return !segments.includes('node_modules') && !segments.includes('.git')
    },
  })

  await npmInstall(destDir)
  const manifest = await readManifest(destDir)

  const buildErrors: string[] = []
  for (const command of manifest.commands) {
    const error = await buildCommand(destDir, command.name)
    if (error) buildErrors.push(`${command.name}: ${error}`)
  }

  return { id: manifest.name, manifest, dir: destDir, buildErrors }
}

export async function installLocalDirectory(sourcePath: string, extensionsRoot: string): Promise<InstalledExtension> {
  if (!existsSync(join(sourcePath, 'package.json'))) {
    throw new Error(`${sourcePath} does not look like an extension directory (no package.json)`)
  }
  return installFromDirectory(sourcePath, extensionsRoot)
}

export async function installStoreSlug(slug: string, extensionsRoot: string): Promise<InstalledExtension> {
  const workDir = join(tmpdir(), `openray-ext-${slug.replace(/[^a-zA-Z0-9_-]/g, '_')}-${process.pid}`)
  await rm(workDir, { recursive: true, force: true })
  await mkdir(workDir, { recursive: true })

  try {
    log(`sparse-cloning raycast/extensions:extensions/${slug}`)
    await execFileAsync('git', [
      'clone',
      '--filter=blob:none',
      '--no-checkout',
      '--depth=1',
      '--sparse',
      'https://github.com/raycast/extensions.git',
      'repo',
    ], { cwd: workDir })

    const repoDir = join(workDir, 'repo')
    await execFileAsync('git', ['sparse-checkout', 'set', '--no-cone', `extensions/${slug}`], { cwd: repoDir })
    await execFileAsync('git', ['checkout', 'main'], { cwd: repoDir })

    const extensionDir = join(repoDir, 'extensions', slug)
    if (!existsSync(extensionDir)) {
      throw new Error(`extensions/${slug} not found in raycast/extensions`)
    }

    return await installFromDirectory(extensionDir, extensionsRoot)
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

export async function uninstallExtension(extensionsRoot: string, id: string): Promise<void> {
  const dir = join(extensionsRoot, id)
  await rm(dir, { recursive: true, force: true })
}
