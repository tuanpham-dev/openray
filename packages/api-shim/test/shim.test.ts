import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { describe, expect, it, beforeAll } from 'vitest'

const require = createRequire(import.meta.url)
const shimPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.cts')

/**
 * index.cts pulls in real, typed component files (interfaces, generics —
 * not valid vanilla JS), so testing it means bundling it first, the same
 * way builder.ts's esbuild alias will always do for real extensions. A raw
 * `require()` of the TS source was only ever valid back when the T19b
 * throwaway stub had zero real imports; that stopped being representative
 * once T20 added real components.
 */
async function bundleShim(): Promise<string> {
  const workDir = mkdtempSync(join(tmpdir(), 'api-shim-bundle-'))
  const outPath = join(workDir, 'shim.cjs')
  await build({ entryPoints: [shimPath], outfile: outPath, bundle: true, platform: 'node', format: 'cjs', external: ['react'] })
  return outPath
}

let bundledShimPath: string
beforeAll(async () => {
  bundledShimPath = await bundleShim()
})

describe('api-shim proxy (bundled require)', () => {
  it('exposes real components directly and stubs known-but-unimplemented names', () => {
    const shim = require(bundledShimPath) as Record<string, unknown>
    expect(typeof shim.List).toBe('function')
    expect(typeof shim.Toast).toBe('function') // known export, T21 hasn't implemented it yet — still a stub
  })

  it('is a concrete object, not a live proxy — unknown names are undefined, not magic stubs', () => {
    const shim = require(bundledShimPath) as Record<string, unknown>
    expect(shim.SomeNameNoRealExtensionUsesYet).toBeUndefined()
  })

  it('supports calling the real List component and constructing stub values without throwing', () => {
    const shim = require(bundledShimPath) as { List: (props: object) => unknown; Toast: new (...args: unknown[]) => unknown }
    expect(() => shim.List({})).not.toThrow()
    expect(() => new shim.Toast({ style: 'animated' })).not.toThrow()
  })

  it('reports a concrete own-key list (regression: esbuild __copyProps needs this)', () => {
    const shim = require(bundledShimPath) as object
    const keys = Object.getOwnPropertyNames(shim)
    expect(keys).toContain('List')
    expect(keys).toContain('Toast')
    expect(keys).toContain('getPreferenceValues')
    expect(keys.length).toBeGreaterThan(0)
  })

  it('reports __esModule as false so esbuild interop treats it as CJS', () => {
    const shim = require(bundledShimPath) as { __esModule: boolean }
    expect(shim.__esModule).toBe(false)
  })
})

describe('api-shim under real esbuild ESM->CJS interop (regression for both fixed bugs)', () => {
  it('resolves named imports to real callable stubs, not undefined, after bundling', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'api-shim-interop-'))
    const entryPath = join(workDir, 'entry.mjs')
    const outPath = join(workDir, 'out.cjs')
    writeFileSync(
      entryPath,
      `import { List, Toast, getPreferenceValues } from ${JSON.stringify(shimPath)}\nexport default { List, Toast, getPreferenceValues }\n`,
    )

    await build({ entryPoints: [entryPath], outfile: outPath, bundle: true, platform: 'node', format: 'cjs', external: ['react'] })

    const bundledSource = readFileSync(outPath, 'utf-8')
    const exportsLine = bundledSource.split('\n').find((line) => line.startsWith('var entry_default'))
    expect(exportsLine).toBeDefined()
    expect(exportsLine).not.toContain('void 0')
    expect(exportsLine).toContain('List: import_src')
    expect(exportsLine).toContain('Toast: import_src')
    expect(exportsLine).toContain('getPreferenceValues: import_src')

    delete require.cache[outPath]
    const result = require(outPath) as { default: { List: unknown; Toast: unknown; getPreferenceValues: unknown } }
    expect(typeof result.default.List).toBe('function')
    expect(typeof result.default.Toast).toBe('function')
    expect(typeof result.default.getPreferenceValues).toBe('function')
  })
})
