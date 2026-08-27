import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Mirrors scripts/build.mjs's esbuild `alias` for the same reason: neither
// this package nor its runtime code (runner.ts's `import ... from 'react'`)
// declares `react` as its own dependency — it's meant to share the exact
// instance `@openray/api-shim` installs, the same way the built host.cjs
// shares it with each separately-bundled extension command (see
// scripts/build.mjs's comment). Without this alias, vitest's resolver
// can't find a bare `react` import from this package's own directory tree
// at all (pnpm's strict, non-hoisted resolution — confirmed empirically).
const here = fileURLToPath(new URL('.', import.meta.url))
const apiShimSrcDir = join(here, '..', 'api-shim', 'src')
const requireFromApiShim = createRequire(join(apiShimSrcDir, 'index.cts'))

export default defineConfig({
  resolve: {
    alias: {
      react: requireFromApiShim.resolve('react'),
      'react/jsx-runtime': requireFromApiShim.resolve('react/jsx-runtime'),
      'react/jsx-dev-runtime': requireFromApiShim.resolve('react/jsx-dev-runtime'),
    },
  },
})
