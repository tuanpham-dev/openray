import { describe, expect, test } from 'vitest'
import { parseScriptMetadata } from '../src/metadata'

// Mirrors src-tauri/src/application/script_commands.rs's own
// `parse_script_metadata` test suite, verbatim where the case applies.

function parse(source: string) {
  return parseScriptMetadata(source, '/tmp/test.sh')
}

describe('parseScriptMetadata', () => {
  test('parses a minimal bash script', () => {
    const script = parse('#!/bin/bash\n# @raycast.schemaVersion 1\n# @raycast.title Say Hello\n# @raycast.mode compact\necho hello\n')
    expect(script).toBeDefined()
    expect(script?.title).toBe('Say Hello')
    expect(script?.mode).toBe('compact')
    expect(script?.arguments).toEqual([])
    expect(script?.needsConfirmation).toBe(false)
  })

  test('rejects files without the required headers', () => {
    expect(parse('#!/bin/bash\necho hi\n')).toBeUndefined()
    // Missing mode.
    expect(parse('# @raycast.schemaVersion 1\n# @raycast.title X\n')).toBeUndefined()
    // Wrong schema version.
    expect(parse('# @raycast.schemaVersion 2\n# @raycast.title X\n# @raycast.mode compact\n')).toBeUndefined()
  })

  test('parses all optional fields and JS comments', () => {
    const script = parse(
      '#!/usr/bin/env node\n' +
        '// @raycast.schemaVersion 1\n' +
        '// @raycast.title Weather\n' +
        '// @raycast.mode fullOutput\n' +
        '// @raycast.icon 🌤\n' +
        '// @raycast.packageName Utilities\n' +
        '// @raycast.description Show the weather\n' +
        '// @raycast.currentDirectoryPath ~\n' +
        '// @raycast.needsConfirmation true\n',
    )
    expect(script?.mode).toBe('fullOutput')
    expect(script?.icon).toBe('🌤')
    expect(script?.packageName).toBe('Utilities')
    expect(script?.description).toBe('Show the weather')
    expect(script?.currentDirectoryPath).toBe('~')
    expect(script?.needsConfirmation).toBe(true)
  })

  test("parses arguments in Raycast's JSON shape", () => {
    const script = parse(
      '# @raycast.schemaVersion 1\n' +
        '# @raycast.title Search\n' +
        '# @raycast.mode silent\n' +
        '# @raycast.argument1 { "type": "text", "placeholder": "query", "percentEncoded": true }\n' +
        '# @raycast.argument2 { "type": "text", "placeholder": "lang", "optional": true }\n',
    )
    const args = script?.arguments ?? []
    expect(args).toHaveLength(2)
    expect(args[0]?.placeholder).toBe('query')
    expect(args[0]?.percentEncoded).toBe(true)
    expect(args[0]?.optional).toBe(false)
    expect(args[1]?.optional).toBe(true)
  })

  test('argument gap truncates to keep positions aligned', () => {
    const script = parse(
      '# @raycast.schemaVersion 1\n# @raycast.title X\n# @raycast.mode compact\n# @raycast.argument2 { "type": "text", "placeholder": "second" }\n',
    )
    expect(script?.arguments).toEqual([])
  })

  test('a code line mentioning the marker is not a header', () => {
    const script = parse('# @raycast.schemaVersion 1\n# @raycast.title Real\n# @raycast.mode compact\necho "@raycast.title Fake"\n')
    expect(script?.title).toBe('Real')
  })
})
