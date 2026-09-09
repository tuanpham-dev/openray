import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

await build({
  entryPoints: [join(root, 'src', 'index.ts')],
  outfile: join(root, 'dist', 'host.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'info',
  // Never inlined: this bundle mounts extension commands that are compiled
  // *separately* (builder.ts, per extension) and require react themselves
  // at runtime. A copy inlined here would be a second React instance, and
  // hooks break with "Invalid hook call" (confirmed empirically — that is
  // exactly what happened before these were externalised). Both sides have
  // to reach the same file through a real runtime `require()` for Node's
  // module cache to hand them one instance.
  //
  // Externalised under their *bare* specifiers rather than the absolute
  // paths this used to resolve them to. Those paths were the packing
  // machine's own — `/home/…/node_modules/.pnpm/react@19.2.8/…` baked into
  // host.cjs — which is fine for a bundle only ever run from this repo and
  // useless in an installed app, where the first thing the sidecar did was
  // fail to require a directory that exists on nobody else's disk. Bare
  // specifiers move the decision to runtime, where both layouts can answer
  // it: pnpm's own symlinks in dev, and the staged `node_modules` that
  // `scripts/stage-extension-host.mjs` ships beside host.cjs in a build.
  //
  // esbuild is external for a different reason — it resolves a native
  // binary relative to its own package directory at runtime, which
  // bundling its JS would break.
  external: ['esbuild', 'react', 'react-reconciler', 'react-reconciler/constants'],
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
