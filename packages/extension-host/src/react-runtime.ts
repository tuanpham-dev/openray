import { createRequire } from 'node:module'
import Module from 'node:module'
import { join, sep } from 'node:path'
import { log } from './rpc'

const requireFromHere = createRequire(__filename)

// __dirname resolves to dist/ at runtime (esbuild injects a real CJS
// __dirname for the bundled host.cjs). packages/api-shim is a sibling of
// packages/extension-host, so this walks dist -> extension-host -> packages
// -> api-shim/src. Dev-mode only, matching the same relative-path
// assumption process.rs makes for host.cjs itself; T24 packaging carries
// api-shim's source alongside the bundle for production.
export const apiShimSrcDir = join(__dirname, '..', '..', 'api-shim', 'src')

/**
 * The three react entry points every extension bundle shares with this
 * process, resolved to absolute paths from api-shim's own installed copy.
 *
 * Real Raycast extensions generally don't declare `react` themselves — it
 * comes transitively from the real `@raycast/api` package (confirmed
 * against 3 real extensions in the T19b spike, none of which list `react`
 * in their own package.json). Since `@raycast/api` is aliased to our own
 * local shim rather than a real npm package, that transitive supply has to
 * come from somewhere else, and this is it.
 */
export function resolveApiShimReactPaths(): Record<string, string> {
  const resolve = (specifier: string) => requireFromHere.resolve(specifier, { paths: [apiShimSrcDir] })
  return {
    react: resolve('react'),
    'react/jsx-runtime': resolve('react/jsx-runtime'),
    'react/jsx-dev-runtime': resolve('react/jsx-dev-runtime'),
  }
}

/** The specifiers {@link installReactResolver} claims. */
export const REACT_SPECIFIERS = ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime']

/**
 * Every command bundle is written here — see `buildCommand`'s `outDir`.
 * Used as the scope test below: a path containing this segment pair is a
 * bundle we built, wherever the extension itself lives (the app's
 * extensions root, a `.orx` unpacked into it, a first-party `extensions/*`
 * folder, or an author's own directory in dev mode).
 */
const BUILD_MARKER = `${sep}.openray${sep}build${sep}`

let installed = false

/**
 * Makes `require("react")` from a built extension bundle resolve to *this
 * process's* react, rather than to whatever Node's own walk-up would find
 * next to the extension.
 *
 * Bundles used to be built with react aliased and externalized by
 * **absolute path**, which made them correct but unportable: the emitted
 * JS literally contained the packing machine's `/home/.../react/index.js`.
 * Externalizing under the bare specifier is what lets a bundle built on one
 * machine run on another — and it moves the "which react?" decision from
 * build time to here.
 *
 * That decision cannot be left to Node. React's hook dispatcher is a
 * module-level singleton: the reconciler that mounts a command lives in
 * this process's react, so a bundle that resolved its own copy (any
 * extension declaring `react` in its dependencies — and `npm install` gives
 * plenty of them one transitively) would fail with "Invalid hook call",
 * which reads as a bug in the extension's code and isn't.
 *
 * Scope is deliberately narrow — only these three specifiers, and only
 * when the requiring file sits in a `.openray/build/` directory. Anything
 * else, including this host's own modules and any non-react import an
 * extension makes, falls straight through to the original resolver.
 */
export function installReactResolver(): void {
  if (installed) return
  installed = true

  let paths: Record<string, string>
  try {
    paths = resolveApiShimReactPaths()
  } catch (error) {
    // Nothing can mount without react anyway; failing loudly here beats a
    // resolver that silently sends every bundle to a different copy.
    log(`react resolver: could not resolve api-shim's react (${error instanceof Error ? error.message : String(error)})`)
    return
  }

  const internals = Module as unknown as {
    _resolveFilename: (request: string, parent: NodeJS.Module | undefined, ...rest: unknown[]) => string
  }
  const original = internals._resolveFilename
  internals._resolveFilename = function patched(this: unknown, request: string, parent, ...rest) {
    const target = paths[request]
    if (target !== undefined && parent?.filename?.includes(BUILD_MARKER)) {
      return target
    }
    return original.call(this, request, parent, ...rest)
  }
}
