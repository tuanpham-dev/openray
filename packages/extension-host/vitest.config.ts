import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { transform } from 'esbuild'
import { defineConfig, type Plugin } from 'vitest/config'

/**
 * Vite treats `.cts` as plain JavaScript and fails to parse the api-shim's
 * TypeScript entry points (`index.cts`, `utils.cts`, `openray.cts`), which
 * `capabilities.ts` imports to read the shim's real export list. The
 * production bundle goes through esbuild, which handles them natively —
 * this teaches the test runner the same thing rather than reshaping the
 * runtime code around a test-only limitation.
 */
const typescriptCommonJs: Plugin = {
  name: 'openray-cts-transform',
  enforce: 'pre',
  async load(id) {
    const [path] = id.split('?')
    if (!path?.endsWith('.cts')) return null
    const source = await readFile(path, 'utf-8')
    const result = await transform(source, { loader: 'tsx', format: 'esm', target: 'node20', jsx: 'automatic', sourcefile: path })
    return result.code
  },
}

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
  plugins: [typescriptCommonJs],
  resolve: {
    alias: {
      react: requireFromApiShim.resolve('react'),
      'react/jsx-runtime': requireFromApiShim.resolve('react/jsx-runtime'),
      'react/jsx-dev-runtime': requireFromApiShim.resolve('react/jsx-dev-runtime'),
    },
  },
})
