import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, mkdir, cp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { build, type Plugin } from 'esbuild'
import type { ExtensionManifest } from '@openray/protocol'
import { apiShimSrcDir, REACT_SPECIFIERS } from './react-runtime'
import { log } from './rpc'

const execFileAsync = promisify(execFile)
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
  if (pkg.export && typeof pkg.export === 'object') {
    const declared = pkg.export as Record<string, unknown>
    if (typeof declared.title === 'string') {
      manifest.export = { title: declared.title }
      if (typeof declared.description === 'string') manifest.export.description = declared.description
      if (typeof declared.entry === 'string') manifest.export.entry = declared.entry
    }
  }
  return manifest
}

/** The module an `export` declaration's hooks live in, defaulting to
 *  `src/export.ts`. Mirrors `ExportDeclaration::entry_name` on the Rust
 *  side — both must agree or the host would require a file the builder
 *  never emitted. */
export const DEFAULT_EXPORT_ENTRY = 'export'

export function exportEntryName(manifest: ExtensionManifest): string | null {
  if (!manifest.export) return null
  return manifest.export.entry ?? DEFAULT_EXPORT_ENTRY
}

/**
 * Bundles an extension's Import/Export hooks, if it declares any. The
 * entry is an ordinary module as far as esbuild is concerned — same
 * options, same output directory as a command — it just isn't a command,
 * so it's built from the manifest's `export` block rather than the
 * command list. Returns an error string (never throws), same convention
 * as {@link buildCommand}; unlike a command, a declared-but-missing entry
 * is worth failing the build over, since the extension would appear in
 * the Import/Export pane and then fail every time it was used.
 */
export async function buildExportEntry(extensionDir: string, manifest: ExtensionManifest): Promise<string | null> {
  const entry = exportEntryName(manifest)
  if (!entry) return null
  const error = await buildCommand(extensionDir, entry)
  if (!error) return null
  return `declares "export" but ${error.replace(`no source file found for command "${entry}"`, `has no src/${entry}.{ts,tsx,js,jsx}`)}`
}

async function npmInstall(extensionDir: string): Promise<void> {
  log(`npm install in ${extensionDir}`)
  await execFileAsync('npm', ['install', '--no-audit', '--no-fund'], { cwd: extensionDir, maxBuffer: 1024 * 1024 * 32 })
}

/** The specifiers whose named imports count as "API surface this extension
 *  depends on" — the compat surface plus OpenRay's own extras, i.e. exactly
 *  what `buildCommand`'s alias map redirects into the shim. */
const API_SPECIFIERS = ['@raycast/api', '@raycast/utils', '@openray/api', '@openray/utils', '@openray/extras']

/**
 * Records which top-level API names an extension actually imports, so a
 * packed archive can be checked against a host's shim *before* it is
 * installed rather than crashing mid-command.
 *
 * This exists because the shim is CommonJS (`index.cts`): esbuild can't
 * statically verify a named import against a CJS module, so
 * `import { Clipboard } from '@raycast/api'` builds cleanly against a shim
 * that has no `Clipboard` and fails at runtime as `undefined is not a
 * function` — an error that points at the extension's code and names
 * nothing that would help. Collecting the names at build time turns that
 * into "requires Clipboard, which this version doesn't provide".
 *
 * Scanned from source text rather than esbuild's metafile, which records
 * which *files* an import reached but not which bindings were taken from
 * it. Static `import` and `require` destructuring are covered; a name
 * assembled at runtime is not, which is the documented limit of the check.
 */
function collectUsedApis(into: Set<string>): Plugin {
  const specifierAlternatives = API_SPECIFIERS.map((specifier) => specifier.replace(/[/@]/g, '\\$&')).join('|')
  const importPattern = new RegExp(String.raw`import\s+([^;'"]+?)\s+from\s*['"](?:${specifierAlternatives})['"]`, 'g')
  const requirePattern = new RegExp(String.raw`(?:const|let|var)\s*(\{[^}]*\})\s*=\s*require\(\s*['"](?:${specifierAlternatives})['"]`, 'g')

  return {
    name: 'openray-collect-used-apis',
    setup(build) {
      build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async (args) => {
        // Only the extension's own sources: node_modules would report a
        // dependency's imports as the extension's own requirements.
        if (args.path.includes(`${sep}node_modules${sep}`)) return null
        const source = await readFile(args.path, 'utf-8')
        for (const pattern of [importPattern, requirePattern]) {
          pattern.lastIndex = 0
          let match: RegExpExecArray | null
          while ((match = pattern.exec(source)) !== null) {
            for (const name of parseImportedNames(match[1] ?? '')) into.add(name)
          }
        }
        // `null` hands the file back to esbuild's own loader untouched —
        // this plugin only observes.
        return null
      })
    },
  }
}

/**
 * Pulls the imported *source* names out of an import clause:
 * `{ List, Action as A }` -> List, Action; `* as api` -> the namespace
 * marker `*`, which the install check reads as "needs the whole surface";
 * a default import contributes nothing (the shim has no default export).
 */
export function parseImportedNames(clause: string): string[] {
  const names: string[] = []
  const namespace = /\*\s+as\s+\w+/.test(clause)
  if (namespace) names.push('*')
  const braces = clause.match(/\{([^}]*)\}/)
  if (braces?.[1]) {
    for (const part of braces[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0]?.trim()
      if (name) names.push(name)
    }
  }
  return names
}

/**
 * Keeps react out of every command bundle **under its bare specifier**,
 * which is what makes a built bundle portable between machines.
 *
 * react has to stay external regardless (React's hook dispatcher is a
 * module-level singleton, and the reconciler that mounts a command lives in
 * the host's own bundle — two inlined copies read as the classic "two React
 * copies" failure even when both came from the same file on disk, because
 * bundling copies code rather than sharing the module instance). The
 * question is only *how* it's externalized, and until T4 the answer was
 * "by absolute path", which baked the building machine's filesystem into
 * the output.
 *
 * It has to be a plugin rather than `external: ['react']`, for the reason
 * the previous absolute-path workaround documented: esbuild matches
 * `external` against the *original* specifier, so once react was aliased to
 * a path, its bare name in `external` silently stopped matching and 11kb of
 * React was inlined with no warning. An `onResolve` hook claims the
 * specifier before any of that, and returning it unchanged with
 * `external: true` is what leaves `require("react")` in the output.
 *
 * The other half of this contract is `react-runtime.ts`'s resolver hook,
 * which decides what that bare `require` means at mount time.
 */
const portableReactExternals: Plugin = {
  name: 'openray-portable-react',
  setup(build) {
    const filter = new RegExp(`^(${REACT_SPECIFIERS.map((specifier) => specifier.replace('/', '\\/')).join('|')})$`)
    build.onResolve({ filter }, (args) => ({ path: args.path, external: true }))
  },
}

/**
 * Bundles one command entry point, aliasing @raycast/api, @raycast/utils
 * (and their @openray/* equivalents),
 * and react (see resolveApiShimReactAliases) to our shim. Non-fatal on
 * failure — a command whose bundle fails (an unimplemented API, an
 * unresolvable import) still gets registered so it appears in search;
 * running it surfaces the real error instead of silently vanishing.
 */
export async function buildCommand(
  extensionDir: string,
  commandName: string,
  usedApis?: Set<string>,
): Promise<string | null> {
  const entryCandidates = ['tsx', 'ts', 'jsx', 'js'].map((ext) => join(extensionDir, 'src', `${commandName}.${ext}`))
  const entry = entryCandidates.find((path) => existsSync(path))
  if (!entry) return `no source file found for command "${commandName}"`

  const outDir = join(extensionDir, '.openray', 'build')
  await mkdir(outDir, { recursive: true })

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
      // extension hit exactly this before this option was added). The
      // `react/jsx-runtime` import it emits is externalized by the plugin
      // below like any other react entry point.
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
      },
      plugins: usedApis ? [portableReactExternals, collectUsedApis(usedApis)] : [portableReactExternals],
    })
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/**
 * The `dependencies`/`devDependencies` blocks of an extension's manifest,
 * serialized — dev mode's cue for "the author added a dependency, npm
 * install has to run again before the next rebuild can resolve it".
 * Compared as a string rather than deep-equalled: key order changes are
 * rare, and a false positive costs one redundant (fast, cached) install
 * while a false negative costs an unresolvable-import build error the
 * author can't act on.
 */
export function dependencySignature(manifest: Record<string, unknown>): string {
  return JSON.stringify([manifest.dependencies ?? {}, manifest.devDependencies ?? {}])
}

/** The manifest as raw JSON, for callers that need fields `readManifest`
 *  deliberately doesn't model (dev mode's dependency-block diffing). */
export async function readRawManifest(extensionDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(extensionDir, 'package.json'), 'utf-8')) as Record<string, unknown>
}

/**
 * Builds an extension **where it already lives** — no copy into the
 * extensions root, no unconditional `npm install`. This is the shape
 * `scripts/build-builtin-extensions.mjs` has always used for first-party
 * extensions (workspace members whose deps the root install already
 * resolved); dev mode needs the same thing for an arbitrary folder the
 * author owns, so the author's directory stays the single source of truth
 * and their editor, git status, and this build all see the same files.
 *
 * `npm install` runs only when `node_modules` is missing or
 * `forceInstall` says the manifest's dependency blocks changed since the
 * last build (see {@link dependencySignature}) — an author adding a
 * dependency mid-session would otherwise get an unresolvable-import error
 * with no obvious cause.
 */
export async function buildExtensionInPlace(
  extensionDir: string,
  options: { forceInstall?: boolean } = {},
): Promise<InstalledExtension> {
  if (options.forceInstall || !existsSync(join(extensionDir, 'node_modules'))) {
    await npmInstall(extensionDir)
  }

  const manifest = await readManifest(extensionDir)
  const buildErrors: string[] = []
  for (const command of manifest.commands) {
    const error = await buildCommand(extensionDir, command.name)
    if (error) buildErrors.push(`${command.name}: ${error}`)
  }
  const exportError = await buildExportEntry(extensionDir, manifest)
  if (exportError) buildErrors.push(exportError)

  return { id: manifest.name, manifest, dir: extensionDir, buildErrors }
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

  // `forceInstall` unconditionally: the copy above deliberately excluded
  // `node_modules`, so a fresh install is always required here — this is
  // the install path, not dev mode's incremental rebuild.
  return buildExtensionInPlace(destDir, { forceInstall: true })
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
