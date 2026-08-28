import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { developList, developStart, developStop, type DevBuildResult } from '../src/dev'

/**
 * A minimal extension directory. `node_modules` is created (empty) so
 * `buildExtensionInPlace` skips `npm install` — these tests exercise the
 * watch/rebuild/notify loop, and shelling out to npm would make them slow
 * and network-dependent for no added coverage.
 */
function makeExtension(commandSource: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'openray-dev-test-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'dev-fixture', title: 'Dev Fixture', commands: [{ name: 'index', title: 'Index', mode: 'view' }] }),
  )
  writeFileSync(join(dir, 'src', 'index.tsx'), commandSource)
  return dir
}

const created: string[] = []

function fixture(source: string): string {
  const dir = makeExtension(source)
  created.push(dir)
  return dir
}

/** Resolves on the next `dev.build` notification, or rejects on timeout. */
function nextBuild(builds: DevBuildResult[], timeoutMs = 10_000): Promise<DevBuildResult> {
  const before = builds.length
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const poll = setInterval(() => {
      if (builds.length > before) {
        clearInterval(poll)
        resolve(builds[builds.length - 1]!)
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(poll)
        reject(new Error('timed out waiting for a dev build notification'))
      }
    }, 20)
  })
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    developStop('dev-fixture')
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('dev mode', () => {
  it('builds in place and reports the extension id', async () => {
    const dir = fixture('export default function Command() { return null }\n')
    const result = await developStart(dir, () => {})

    expect(result.id).toBe('dev-fixture')
    expect(result.dir).toBe(dir)
    expect(result.buildErrors).toEqual([])
    // Built where it lives — no copy into an extensions root.
    await expect(readFile(join(dir, '.openray', 'build', 'index.js'), 'utf-8')).resolves.toContain('Command')
    expect(developList()).toEqual([{ id: 'dev-fixture', dir }])
  })

  it('starts dev mode even when the initial build fails, reporting the error', async () => {
    const dir = fixture('import { nope } from "./missing"\nexport default function Command() { return nope }\n')
    const result = await developStart(dir, () => {})

    expect(result.id).toBe('dev-fixture')
    expect(result.buildErrors.join('\n')).toContain('index')
    // The watcher is running regardless, so fixing the file recovers
    // without the author having to start dev mode again.
    expect(developList()).toHaveLength(1)
  })

  it('rebuilds and notifies when a source file changes', async () => {
    const dir = fixture('export default function Command() { return "before" }\n')
    const builds: DevBuildResult[] = []
    await developStart(dir, (build) => builds.push(build))

    writeFileSync(join(dir, 'src', 'index.tsx'), 'export default function Command() { return "after" }\n')
    const build = await nextBuild(builds)

    expect(build.extensionId).toBe('dev-fixture')
    expect(build.errors).toEqual([])
    expect(build.commands).toEqual(['index'])
    expect(build.manifestChanged).toBe(false)
    await expect(readFile(join(dir, '.openray', 'build', 'index.js'), 'utf-8')).resolves.toContain('after')
  })

  it('reports a build error without tearing the session down', async () => {
    const dir = fixture('export default function Command() { return null }\n')
    const builds: DevBuildResult[] = []
    await developStart(dir, (build) => builds.push(build))

    writeFileSync(join(dir, 'src', 'index.tsx'), 'import { nope } from "./missing"\nexport default nope\n')
    const failed = await nextBuild(builds)
    expect(failed.errors.join('\n')).toContain('index')

    writeFileSync(join(dir, 'src', 'index.tsx'), 'export default function Command() { return "fixed" }\n')
    const recovered = await nextBuild(builds)
    expect(recovered.errors).toEqual([])
  })

  it('flags a manifest change and carries the re-read manifest', async () => {
    const dir = fixture('export default function Command() { return null }\n')
    const builds: DevBuildResult[] = []
    await developStart(dir, (build) => builds.push(build))

    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'dev-fixture',
        title: 'Renamed Fixture',
        commands: [{ name: 'index', title: 'Index', mode: 'view' }],
      }),
    )
    const build = await nextBuild(builds)

    expect(build.manifestChanged).toBe(true)
    expect(build.manifest?.title).toBe('Renamed Fixture')
  })

  it('stops watching on developStop', async () => {
    const dir = fixture('export default function Command() { return null }\n')
    const builds: DevBuildResult[] = []
    await developStart(dir, (build) => builds.push(build))

    expect(developStop('dev-fixture')).toBe(true)
    expect(developStop('dev-fixture')).toBe(false)
    expect(developList()).toEqual([])

    writeFileSync(join(dir, 'src', 'index.tsx'), 'export default function Command() { return "ignored" }\n')
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(builds).toHaveLength(0)
  })

  it('rejects a directory with no manifest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openray-dev-empty-'))
    created.push(dir)
    await expect(developStart(dir, () => {})).rejects.toThrow(/no package.json/)
  })
})
