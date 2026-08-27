import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { encodeFrame, FrameDecoder, isRpcNotification, isRpcRequest, isRpcResponse, type RpcMessage } from '../src/rpc'
import type { UiTreeCommit } from '../src/ui-tree'
import type { ExtensionManifest } from '../src/manifest'

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')

function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(fixturesDir, name), 'utf-8')) as T
}

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

describe('rpc message round-trip', () => {
  it('round-trips a request', () => {
    const original = loadFixture<RpcMessage>('request.json')
    expect(roundTrip(original)).toEqual(original)
    expect(isRpcRequest(original)).toBe(true)
  })

  it('round-trips a notification', () => {
    const original = loadFixture<RpcMessage>('notification.json')
    expect(roundTrip(original)).toEqual(original)
    expect(isRpcNotification(original)).toBe(true)
  })

  it('round-trips an ok response', () => {
    const original = loadFixture<RpcMessage>('response-ok.json')
    expect(roundTrip(original)).toEqual(original)
    expect(isRpcResponse(original)).toBe(true)
  })

  it('round-trips an error response', () => {
    const original = loadFixture<RpcMessage>('response-error.json')
    expect(roundTrip(original)).toEqual(original)
    expect(isRpcResponse(original)).toBe(true)
  })
})

describe('frame encoding', () => {
  it('encodes and decodes a single frame', () => {
    const original = loadFixture<RpcMessage>('request.json')
    const frame = encodeFrame(original)
    const decoder = new FrameDecoder()
    const [decoded] = decoder.push(frame)
    expect(decoded).toEqual(original)
  })

  it('decodes frames split across chunks', () => {
    const original = loadFixture<RpcMessage>('response-ok.json')
    const frame = encodeFrame(original)
    const decoder = new FrameDecoder()
    const mid = Math.floor(frame.length / 2)
    expect(decoder.push(frame.subarray(0, mid))).toEqual([])
    const [decoded] = decoder.push(frame.subarray(mid))
    expect(decoded).toEqual(original)
  })

  it('decodes multiple queued frames from one chunk', () => {
    const a = loadFixture<RpcMessage>('request.json')
    const b = loadFixture<RpcMessage>('notification.json')
    const combined = new Uint8Array([...encodeFrame(a), ...encodeFrame(b)])
    const decoder = new FrameDecoder()
    const [first, second] = decoder.push(combined)
    expect(first).toEqual(a)
    expect(second).toEqual(b)
  })
})

describe('ui-tree round-trip', () => {
  it('round-trips a snapshot commit', () => {
    const original = loadFixture<UiTreeCommit>('ui-snapshot.json')
    expect(roundTrip(original)).toEqual(original)
  })

  it('round-trips a diff commit', () => {
    const original = loadFixture<UiTreeCommit>('ui-diff.json')
    expect(roundTrip(original)).toEqual(original)
  })
})

describe('manifest round-trip', () => {
  it('round-trips an extension manifest', () => {
    const original = loadFixture<ExtensionManifest>('manifest.json')
    expect(roundTrip(original)).toEqual(original)
    expect(original.commands).toHaveLength(2)
  })
})
