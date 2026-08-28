import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { unzipSync, zipSync } from 'fflate'
import { installArchive, ORX_ROOT, packExtension, findUnpackableDependencies } from '../src/pack'
import { missingApis, providedApis } from '../src/capabilities'
import { parseImportedNames } from '../src/builder'

const created: string[] = []

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `openray-${prefix}-`))
  created.push(dir)
  return dir
}

interface FixtureOptions {
  name?: string
  version?: string
  source?: string
  license?: boolean
  dependency?: { name: string; files: Record<string, string> }
  /** Declared in the manifest — what the attribution check actually reads,
   *  since esbuild inlines declared dependencies into the bundles. */
  dependencies?: Record<string, string>
  scripts?: Record<string, string>
}

function extensionFixture(options: FixtureOptions = {}): string {
  const dir = scratch('pack-src')
  const name = options.name ?? 'packable'
  mkdirSync(join(dir, 'src'), { recursive: true })
  // Present but empty: `buildExtensionInPlace` shells out to npm when it's
  // missing, which these tests neither need nor should depend on.
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name,
      title: 'Packable',
      version: options.version ?? '1.2.3',
      commands: [{ name: 'index', title: 'Index', mode: 'view' }],
      ...(options.dependencies ? { dependencies: options.dependencies } : {}),
      ...(options.scripts ? { scripts: options.scripts } : {}),
    }),
  )
  writeFileSync(
    join(dir, 'src', 'index.tsx'),
    options.source ?? 'import { List } from "@raycast/api"\nexport default function Command() { return <List /> }\n',
  )
  if (options.license) writeFileSync(join(dir, 'LICENSE'), 'MIT\n')
  if (options.dependency) {
    const depDir = join(dir, 'node_modules', options.dependency.name)
    mkdirSync(depDir, { recursive: true })
    for (const [file, content] of Object.entries(options.dependency.files)) {
      writeFileSync(join(depDir, file), content)
    }
  }
  return dir
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('capability check', () => {
  it('reports names the shim does not export', () => {
    expect(missingApis(['List', 'ActionPanel'])).toEqual([])
    expect(missingApis(['List', 'TimeMachineBrowser'])).toEqual(['TimeMachineBrowser'])
  })

  it('treats a namespace import as satisfiable rather than requiring everything', () => {
    expect(missingApis(['*'])).toEqual([])
  })

  it('reads a real export surface, not an empty set', () => {
    // Guards against the check silently passing everything because the
    // shim import resolved to nothing.
    const provided = providedApis()
    expect(provided.has('List')).toBe(true)
    expect(provided.has('showToast')).toBe(true)
    expect(provided.size).toBeGreaterThan(20)
  })
})

describe('import-clause parsing', () => {
  it('takes source names, not local aliases', () => {
    expect(parseImportedNames('{ List, Action as Act }')).toEqual(['List', 'Action'])
  })

  it('marks a namespace import', () => {
    expect(parseImportedNames('* as api')).toEqual(['*'])
  })

  it('ignores a default import, which the shim has no counterpart for', () => {
    expect(parseImportedNames('Something')).toEqual([])
  })
})

describe('pack → install round trip', () => {
  it('packs a built extension and installs it into a clean root', async () => {
    const source = extensionFixture()
    const out = scratch('pack-out')
    const packed = await packExtension(source, out, { packedAt: '2026-08-27T00:00:00.000Z' })

    expect(packed.file).toBe('packable-1.2.3.orx')
    expect(packed.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(packed.usedApis).toContain('List')

    const entries = unzipSync(new Uint8Array(readFileSync(join(out, packed.file))))
    const names = Object.keys(entries)
    // Everything under one top-level directory, bundles included, sources
    // carried along for inspection.
    expect(names.every((name) => name.startsWith(`${ORX_ROOT}/`))).toBe(true)
    expect(names).toContain(`${ORX_ROOT}/.openray/build/index.js`)
    expect(names).toContain(`${ORX_ROOT}/openray.pack.json`)
    expect(names.some((name) => name.includes('node_modules'))).toBe(false)

    const root = scratch('ext-root')
    const installed = await installArchive(join(out, packed.file), root)
    expect(installed.id).toBe('packable')
    expect(installed.version).toBe('1.2.3')
    expect(installed.dir).toBe(join(root, 'packable'))
    // The installed copy runs from the *packed* bundle — no build happened
    // on this side at all.
    expect(existsSync(join(root, 'packable', '.openray', 'build', 'index.js'))).toBe(true)
  })

  it('keeps the previous version when an install fails', async () => {
    const root = scratch('ext-root')
    const existing = join(root, 'packable')
    mkdirSync(existing, { recursive: true })
    writeFileSync(join(existing, 'marker.txt'), 'original')

    // An archive whose manifest is unreadable: far enough in to have moved
    // the old directory aside, if the staging were done carelessly.
    const broken = join(scratch('broken'), 'broken.orx')
    writeFileSync(
      broken,
      zipSync({
        [`${ORX_ROOT}/package.json`]: new TextEncoder().encode('{ not json'),
        [`${ORX_ROOT}/openray.pack.json`]: new TextEncoder().encode(JSON.stringify({ formatVersion: 1, usedApis: [] })),
      }),
    )

    await expect(installArchive(broken, root)).rejects.toThrow()
    expect(readFileSync(join(existing, 'marker.txt'), 'utf-8')).toBe('original')
  })

  it('refuses an archive needing an API this build lacks', async () => {
    const root = scratch('ext-root')
    const archive = join(scratch('future'), 'future.orx')
    writeFileSync(
      archive,
      zipSync({
        [`${ORX_ROOT}/package.json`]: new TextEncoder().encode(
          JSON.stringify({ name: 'from-the-future', title: 'Future', commands: [] }),
        ),
        [`${ORX_ROOT}/.openray/build/index.js`]: new TextEncoder().encode('module.exports = {}'),
        [`${ORX_ROOT}/openray.pack.json`]: new TextEncoder().encode(
          JSON.stringify({ formatVersion: 1, usedApis: ['List', 'HoloDeck'] }),
        ),
      }),
    )

    await expect(installArchive(archive, root)).rejects.toThrow(/HoloDeck/)
  })

  it('refuses an archive from a newer container format', async () => {
    const root = scratch('ext-root')
    const archive = join(scratch('newer'), 'newer.orx')
    writeFileSync(
      archive,
      zipSync({
        [`${ORX_ROOT}/package.json`]: new TextEncoder().encode(JSON.stringify({ name: 'newer', title: 'Newer', commands: [] })),
        [`${ORX_ROOT}/openray.pack.json`]: new TextEncoder().encode(JSON.stringify({ formatVersion: 99, usedApis: [] })),
      }),
    )

    await expect(installArchive(archive, root)).rejects.toThrow(/newer version of OpenRay/)
  })

  it('refuses an entry that would escape the extension directory', async () => {
    const root = scratch('ext-root')
    const archive = join(scratch('slip'), 'slip.orx')
    writeFileSync(
      archive,
      zipSync({
        [`${ORX_ROOT}/../../escaped.txt`]: new TextEncoder().encode('pwned'),
        [`${ORX_ROOT}/package.json`]: new TextEncoder().encode(JSON.stringify({ name: 'slip', title: 'Slip', commands: [] })),
        [`${ORX_ROOT}/openray.pack.json`]: new TextEncoder().encode(JSON.stringify({ formatVersion: 1, usedApis: [] })),
      }),
    )

    await expect(installArchive(archive, root)).rejects.toThrow(/escapes/)
  })

  it('refuses a file that is not an archive of ours', async () => {
    const root = scratch('ext-root')
    const notOurs = join(scratch('other'), 'other.orx')
    writeFileSync(notOurs, zipSync({ 'some/other/layout.txt': new TextEncoder().encode('hi') }))
    await expect(installArchive(notOurs, root)).rejects.toThrow(/not an OpenRay extension archive/)
  })
})

describe('pack-time refusals', () => {
  it('refuses a native dependency', async () => {
    const source = extensionFixture({
      license: true,
      dependency: { name: 'sharpish', files: { 'binding.node': 'binary', 'package.json': '{"name":"sharpish"}' } },
    })
    expect(await findUnpackableDependencies(source)).toContainEqual(expect.stringContaining('binding.node'))
    await expect(packExtension(source, scratch('pack-out'))).rejects.toThrow(/can't be packed portably/)
  })

  it('refuses an install script', async () => {
    const source = extensionFixture({ scripts: { postinstall: 'node build.js' } })
    await expect(packExtension(source, scratch('pack-out'))).rejects.toThrow(/install script/)
  })

  it('refuses an extension whose inlined third-party code has no LICENSE', async () => {
    const source = extensionFixture({
      dependencies: { 'left-pad': '^1.3.0' },
      dependency: { name: 'left-pad', files: { 'index.js': 'module.exports = 1', 'package.json': '{"name":"left-pad"}' } },
    })
    await expect(packExtension(source, scratch('pack-out'))).rejects.toThrow(/no LICENSE/)
  })

  it('does not demand a LICENSE for workspace-linked dependencies', async () => {
    // First-party code from the same repository, covered by the repo's own
    // license — every built-in extension is shaped like this, and demanding
    // a per-extension LICENSE for them was the check's first, wrong form.
    const source = extensionFixture({ dependencies: { '@openray/placeholders': 'workspace:*' } })
    await expect(packExtension(source, scratch('pack-out'))).resolves.toMatchObject({ id: 'packable' })
  })

  it('accepts inlined third-party code when a LICENSE travels with it', async () => {
    const source = extensionFixture({ dependencies: { 'left-pad': '^1.3.0' }, license: true })
    await expect(packExtension(source, scratch('pack-out'))).resolves.toMatchObject({ id: 'packable' })
  })

  it('refuses an extension that does not build cleanly', async () => {
    const source = extensionFixture({ source: 'import { x } from "./nowhere"\nexport default x\n' })
    await expect(packExtension(source, scratch('pack-out'))).rejects.toThrow(/did not build cleanly/)
  })
})
