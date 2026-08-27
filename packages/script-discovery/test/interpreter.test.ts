import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { resolveInterpreter } from '../src/interpreter'

// Mirrors src-tauri/src/application/script_commands.rs's Unix-branch
// `resolve_interpreter` tests — the only branch this Linux-only port
// carries (see interpreter.ts's own doc comment).

describe('resolveInterpreter', () => {
  test('an executable file runs as itself', () => {
    const dir = mkdtempSync(join(tmpdir(), 'openray-script-discovery-test-'))
    const script = join(dir, 'run.sh')
    writeFileSync(script, '#!/bin/bash\necho hi\n')
    chmodSync(script, 0o755)

    const { program, args } = resolveInterpreter(script, '#!/bin/bash')
    expect(program).toBe(script)
    expect(args).toEqual([])
  })

  test('a non-executable script falls back to its shebang', () => {
    const { program, args } = resolveInterpreter('/nonexistent/x.foo', '#!/usr/bin/env python3')
    expect(program).toBe('/usr/bin/env')
    expect(args).toEqual(['python3', '/nonexistent/x.foo'])
  })

  test('extension fallback picks an interpreter when there is no shebang', () => {
    const cases: [string, string][] = [
      ['x.py', 'python3'],
      ['x.sh', 'bash'],
      ['x.applescript', 'osascript'],
      ['x.swift', 'swift'],
    ]
    for (const [file, expected] of cases) {
      const { program } = resolveInterpreter(`/nonexistent/${file}`, '')
      expect(program, file).toBe(expected)
    }
  })
})
