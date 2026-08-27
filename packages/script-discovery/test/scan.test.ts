import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { discoverScripts, expandHome } from '../src/scan'

describe('discoverScripts', () => {
  test('discovers scripts recursively and sorts by title', () => {
    const dir = mkdtempSync(join(tmpdir(), 'openray-scripts-scan-test-'))
    const nested = join(dir, 'nested')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(dir, 'b.sh'), '# @raycast.schemaVersion 1\n# @raycast.title Bravo\n# @raycast.mode compact\n')
    writeFileSync(join(nested, 'a.sh'), '# @raycast.schemaVersion 1\n# @raycast.title Alpha\n# @raycast.mode compact\n')
    writeFileSync(join(dir, 'not-a-script.txt'), 'just text\n')

    const scripts = discoverScripts([dir])
    rmSync(dir, { recursive: true, force: true })

    expect(scripts.map((s) => s.title)).toEqual(['Alpha', 'Bravo'])
  })
})

describe('expandHome', () => {
  test('expands a leading ~/ against $HOME', () => {
    expect(expandHome('/abs/path')).toBe('/abs/path')
    if (process.env.HOME) {
      expect(expandHome('~/scripts')).not.toContain('~')
      expect(expandHome('~/scripts').startsWith('/')).toBe(true)
    }
  })

  test('a bare ~ (no trailing slash) passes through untouched', () => {
    expect(expandHome('~')).toBe('~')
  })
})
