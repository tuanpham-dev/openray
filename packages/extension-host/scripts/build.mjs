import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const apiShimDir = join(root, '..', 'api-shim', 'src')
const requireFromApiShim = createRequire(join(apiShimDir, 'index.cts'))

await build({
  entryPoints: [join(root, 'src', 'index.ts')],
  outfile: join(root, 'dist', 'host.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'info',
  // esbuild resolves a symlinked workspace package's own dependencies
  // (react, react-reconciler) relative to the symlink's *apparent* location
  // rather than walking up from its real on-disk directory (a known
  // pnpm+esbuild interaction, confirmed empirically — plain resolution
  // fails with "Could not resolve react" despite packages/api-shim/
  // node_modules/react existing). Aliasing to the resolved absolute path
  // sidesteps it.
  //
  // react/react-reconciler are ALSO listed in `external` below — this
  // bundle mounts extension commands that are compiled *separately*
  // (builder.ts, per extension) with react externalized to this exact same
  // resolved path. If react were inlined here instead, host.cjs would get
  // its own copy at build time and extensions would get a second copy via
  // their own real `require()` at runtime — two React instances, hooks
  // break with "Invalid hook call" (confirmed empirically: this is exactly
  // what happened before external was added here). Both sides must do a
  // real runtime `require()` of the identical absolute path so Node's
  // module cache actually shares one instance. T24 packaging needs to ship
  // this react copy (and api-shim's own source) alongside the sidecar
  // binary for the same reason it already has to ship api-shim's source —
  // neither is compiled into host.cjs.
  alias: {
    react: requireFromApiShim.resolve('react'),
    'react-reconciler': requireFromApiShim.resolve('react-reconciler'),
    'react-reconciler/constants': requireFromApiShim.resolve('react-reconciler/constants'),
  },
  // esbuild ships a native binary resolved relative to its own package
  // directory at runtime; bundling its JS breaks that resolution. Keep it
  // external — dist/host.js is run from within this package's node_modules
  // in dev. T24 (packaging) carries esbuild's package dir alongside the
  // bundle for production.
  external: [
    'esbuild',
    requireFromApiShim.resolve('react'),
    requireFromApiShim.resolve('react-reconciler'),
    requireFromApiShim.resolve('react-reconciler/constants'),
  ],
})

// A third entry point: the build/pack pipeline for tooling that runs with
// no app present — `openray pack` and a registry repo's CI. Same modules
// the sidecar uses, exposed as plain CJS exports.
await build({
  entryPoints: [join(root, 'src', 'cli-api.ts')],
  outfile: join(root, 'dist', 'cli-api.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'info',
  jsx: 'automatic',
  external: ['esbuild'],
})

// A second, separate entry point exposing builder.ts's `buildCommand`/
// `readManifest` as real, directly-`require`-able CJS exports — used by
// the repo-root `scripts/build-builtin-extensions.mjs` (T12) to build
// first-party `extensions/*` packages without going through the sidecar
// process at all. `index.ts` already bundles builder.ts too (the running
// sidecar uses it for user-installed extensions), but only as inlined,
// non-exported code inside host.cjs's own closure.
await build({
  entryPoints: [join(root, 'src', 'builder.ts')],
  outfile: join(root, 'dist', 'builder.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'info',
  external: ['esbuild'],
})
