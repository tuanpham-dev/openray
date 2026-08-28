import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildCommand } from '../src/builder'
import { installReactResolver, resolveApiShimReactPaths } from '../src/react-runtime'

/**
 * These cover the half of T4 that makes `.orx` archives possible at all: a
 * bundle built here has to run *on another machine*, which means it can't
 * contain this machine's paths — and the moment react is referenced by its
 * bare name instead, something has to guarantee the bundle still gets the
 * host's single react instance rather than whatever `npm install` left in
 * the extension's own `node_modules`.
 */

const created: string[] = []

function scratchExtension(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'openray-portable-'))
  created.push(dir)
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'portable-fixture', title: 'Portable', commands: [] }))
  writeFileSync(join(dir, 'src', 'index.tsx'), source)
  return dir
}

/**
 * Plants a react in the extension's own `node_modules` — the exact thing
 * Node's resolution would find first from a bundle at
 * `<dir>/.openray/build/`. Any real extension that lists react as a
 * dependency ends up in this state after `npm install`.
 */
function plantDecoyReact(dir: string): void {
  const decoyDir = join(dir, 'node_modules', 'react')
  mkdirSync(decoyDir, { recursive: true })
  writeFileSync(join(decoyDir, 'package.json'), JSON.stringify({ name: 'react', version: '0.0.0-decoy', main: 'index.js' }))
  writeFileSync(join(decoyDir, 'index.js'), 'module.exports = { __decoy: true }\n')
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('portable command bundles', () => {
  it('externalizes react under its bare specifier, with no machine paths in the output', async () => {
    const dir = scratchExtension('export default function Command() { return <list /> }\n')
    expect(await buildCommand(dir, 'index')).toBeNull()

    const bundle = readFileSync(join(dir, '.openray', 'build', 'index.js'), 'utf-8')
    expect(bundle).toContain('require("react/jsx-runtime")')

    // The actual portability assertion: no absolute path to the *building*
    // machine's react survives into the artifact. Before T4 the bundle
    // carried `require("/home/…/node_modules/react/index.js")`, which is
    // exactly what made an archive un-shippable.
    const reactPaths = Object.values(resolveApiShimReactPaths())
    for (const path of reactPaths) {
      expect(bundle).not.toContain(path)
    }
  })

  it('still inlines the api shim rather than externalizing it', async () => {
    // Only react is shared at runtime; the component library is meant to be
    // baked in, so an archive doesn't depend on a shim layout it can't see.
    const dir = scratchExtension('import { List } from "@raycast/api"\nexport default function Command() { return <List /> }\n')
    expect(await buildCommand(dir, 'index')).toBeNull()

    const bundle = readFileSync(join(dir, '.openray', 'build', 'index.js'), 'utf-8')
    expect(bundle).not.toContain('require("@raycast/api")')
  })

  it('resolves a bundle’s bare react to the host’s copy even when the extension ships its own', async () => {
    // Returns the react namespace itself, so the assertion is about
    // *which* react was resolved, with no reconciler or JSX in the way.
    const dir = scratchExtension('import * as React from "react"\nexport default function Command() { return React }\n')
    expect(await buildCommand(dir, 'index')).toBeNull()
    plantDecoyReact(dir)

    installReactResolver()
    const bundlePath = join(dir, '.openray', 'build', 'index.js')
    const requireBundle = createRequire(bundlePath)
    const loaded = requireBundle(bundlePath) as { default: () => unknown }

    const got = loaded.default() as Record<string, unknown>
    // The decoy is what Node's own walk-up finds first; getting real
    // react's surface instead is the resolver hook doing its job. Without
    // it this is the "Invalid hook call" bug, one indirection earlier.
    expect(got.__decoy).toBeUndefined()
    expect(typeof got.useState).toBe('function')

    // Same *instance*, not merely a react-shaped object — the whole point
    // is one module-level hook dispatcher shared with the reconciler.
    // Compared by function identity rather than object identity: the
    // bundle holds esbuild's ESM-interop namespace around the module, a
    // different object that re-exports the very same functions.
    const hostReact = requireBundle(resolveApiShimReactPaths().react as string) as Record<string, unknown>
    expect(got.useState).toBe(hostReact.useState)
  })

  it('leaves non-bundle callers on the normal resolver', async () => {
    // Scope check: the hook keys on the `.openray/build/` segment, so a
    // require from anywhere else — including this test file — must be
    // untouched. If this ever resolved through the hook, every module in
    // the host process would be one bad predicate away from a surprise.
    installReactResolver()
    const dir = scratchExtension('export default function Command() { return null }\n')
    plantDecoyReact(dir)

    const requireFromExtensionRoot = createRequire(join(dir, 'probe.js'))
    expect((requireFromExtensionRoot('react') as { __decoy?: boolean }).__decoy).toBe(true)
    expect(join(dir, '.openray', 'build', 'index.js')).toContain(`${sep}.openray${sep}build${sep}`)
  })
})
