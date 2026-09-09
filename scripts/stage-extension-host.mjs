/**
 * Assembles everything the extension host needs at runtime into one
 * directory, for `tauri build` to ship as a resource.
 *
 * `host.cjs` is a bundle, but not a self-contained one. Three things are
 * deliberately left out of it and have to arrive some other way:
 *
 *   - **react and react-reconciler**, because a copy inlined into the
 *     sidecar would be a second React instance next to the one every
 *     extension bundle requires for itself, and hooks break with "Invalid
 *     hook call" when a component is mounted by one and rendered by the
 *     other. See `scripts/build.mjs` in packages/extension-host.
 *   - **esbuild**, because it resolves a native binary relative to its own
 *     package directory, which bundling its JS would break. It is not
 *     optional weight: every install, pack, and dev-mode rebuild compiles
 *     an extension through it, so a build without it can run only what
 *     shipped prebuilt.
 *   - **@openray/api-shim's TypeScript sources**, which `buildCommand`
 *     aliases `@raycast/api` and its siblings straight at — esbuild reads
 *     those `.cts` files on every build the app does.
 *
 * In this repo pnpm's symlinks answer all three. An installed app has no
 * such tree, so the packages are copied here into a plain `node_modules`
 * beside `host.cjs`, which is exactly where Node's own walk-up looks. The
 * layout is what makes the copies agree: react sits at the top of that
 * tree, so the sidecar's own `require('react')` and the resolution
 * `react-runtime.ts` does from api-shim's directory land on one file.
 */
import { createRequire } from 'node:module'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const hostDir = join(root, 'packages', 'extension-host')
const apiShimDir = join(root, 'packages', 'api-shim')
const staged = join(hostDir, 'staged')

const requireFromHost = createRequire(join(hostDir, 'src', 'index.ts'))
const requireFromApiShim = createRequire(join(apiShimDir, 'src', 'index.cts'))

/**
 * esbuild picks its binary package by the platform it finds itself running
 * on, so the one staged has to be the one the *built app* will run on.
 * That is the build host: the release matrix builds every target on its own
 * native runner, and a cross-build would need this reconsidered rather than
 * silently shipping the wrong architecture's binary.
 */
function esbuildBinaryPackage() {
  const key = `${process.platform} ${process.arch}`
  const names = {
    'darwin arm64': '@esbuild/darwin-arm64',
    'darwin x64': '@esbuild/darwin-x64',
    'linux arm64': '@esbuild/linux-arm64',
    'linux x64': '@esbuild/linux-x64',
    'win32 arm64': '@esbuild/win32-arm64',
    'win32 x64': '@esbuild/win32-x64',
  }
  const name = names[key]
  if (name === undefined) throw new Error(`no esbuild binary package known for ${key}`)
  return name
}

const stagedPackages = new Set()

/**
 * Copies a package and everything it declares a runtime dependency on,
 * symlinks resolved — pnpm's tree is symlinks all the way down and an
 * installed app must not be.
 *
 * The walk is what makes this correct rather than merely plausible:
 * react-reconciler pulls in `scheduler`, which nothing here names and the
 * isolated run failed on ("Could not resolve \"scheduler\"") the moment the
 * repo's own node_modules was out of reach. Each dependency is resolved
 * from its dependent's real directory, so pnpm's per-package resolution is
 * preserved rather than re-guessed.
 *
 * `optionalDependencies` are deliberately not followed — esbuild lists a
 * native binary for every platform it supports, and the one that matters
 * here is staged explicitly below.
 */
function stagePackage(name, resolvedFrom) {
  const manifestPath = resolvedFrom.resolve(`${name}/package.json`)
  const source = dirname(manifestPath)
  if (stagedPackages.has(name)) return source
  stagedPackages.add(name)

  const destination = join(staged, 'node_modules', name)
  mkdirSync(dirname(destination), { recursive: true })
  cpSync(source, destination, { recursive: true, dereference: true })

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const resolvedFromHere = createRequire(manifestPath)
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    stagePackage(dependency, resolvedFromHere)
  }
  return source
}

const hostBundle = join(hostDir, 'dist', 'host.cjs')
if (!existsSync(hostBundle)) {
  throw new Error(`${hostBundle} is missing — run \`pnpm --filter @openray/extension-host build\` first`)
}

rmSync(staged, { recursive: true, force: true })
mkdirSync(staged, { recursive: true })
stagedPackages.clear()
cpSync(hostBundle, join(staged, 'host.cjs'))

// Resolved from api-shim rather than from the host package so that the copy
// staged is the same one api-shim's own dependency graph points at — the
// single-React-instance rule above is a claim about file identity, and this
// is where it is decided.
stagePackage('react', requireFromApiShim)
stagePackage('react-reconciler', requireFromApiShim)

// Resolved from esbuild's own directory in this repo, not from the copy
// just staged: the binary package is one of esbuild's optional
// dependencies, and only the tree it was installed into knows where it is.
const esbuildSource = stagePackage('esbuild', requireFromHost)
const binaryPackage = esbuildBinaryPackage()
stagePackage(binaryPackage, createRequire(join(esbuildSource, 'lib', 'main.js')))

// Only what api-shim itself declares shippable (`files: ["src"]`) plus the
// manifest, which `react-runtime.ts` resolves by name to find the directory.
const apiShimStaged = join(staged, 'node_modules', '@openray', 'api-shim')
mkdirSync(apiShimStaged, { recursive: true })
cpSync(join(apiShimDir, 'package.json'), join(apiShimStaged, 'package.json'))
cpSync(join(apiShimDir, 'src'), join(apiShimStaged, 'src'), { recursive: true, dereference: true })

console.log(`staged extension host -> ${staged}`)
console.log(`  ${stagedPackages.size} packages, esbuild binary ${binaryPackage}: ${[...stagedPackages].sort().join(', ')}`)
