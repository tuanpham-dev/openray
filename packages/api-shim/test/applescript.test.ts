import { describe, expect, it } from 'vitest'
import { osascriptArgs, runAppleScript } from '../src/api/applescript'

describe('runAppleScript', () => {
  it('refuses honestly off macOS instead of silently doing nothing', async () => {
    // The whole point of shipping this rather than leaving a stub: an
    // extension calling it on Linux gets a real error it can report,
    // not a swallowed no-op.
    if (process.platform === 'darwin') return
    await expect(runAppleScript('return 1')).rejects.toThrow(/only available on macOS/)
  })

  it('builds a plain AppleScript invocation', () => {
    expect(osascriptArgs('/tmp/s.applescript', [])).toEqual(['/tmp/s.applescript'])
  })

  it('passes script arguments through after the script', () => {
    expect(osascriptArgs('/tmp/s.applescript', ['one', 'two'])).toEqual(['/tmp/s.applescript', 'one', 'two'])
  })

  it('selects the JXA language when asked', () => {
    expect(osascriptArgs('/tmp/s.js', [], { language: 'JavaScript' })).toEqual(['-l', 'JavaScript', '/tmp/s.js'])
  })

  it('switches to machine-readable output only when explicitly disabled', () => {
    expect(osascriptArgs('/tmp/s.applescript', [], { humanReadableOutput: false })).toEqual(['-ss', '/tmp/s.applescript'])
    expect(osascriptArgs('/tmp/s.applescript', [], { humanReadableOutput: true })).toEqual(['/tmp/s.applescript'])
  })
})
