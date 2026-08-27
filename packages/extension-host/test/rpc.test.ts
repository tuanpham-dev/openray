import { describe, expect, it, vi } from 'vitest'
import { encodeFrame, FrameDecoder, type RpcMessage, type RpcResponse } from '@openray/protocol'
import { RpcDispatcher } from '../src/rpc'
import { registerHostMethods } from '../src/loader'

function makeDispatcher() {
  const written: Uint8Array[] = []
  const dispatcher = new RpcDispatcher((bytes) => written.push(bytes))
  return { dispatcher, written }
}

function decodeAll(chunks: Uint8Array[]): RpcMessage[] {
  const decoder = new FrameDecoder()
  return chunks.flatMap((chunk) => decoder.push(chunk))
}

function asResponse(message: RpcMessage): RpcResponse {
  return message as unknown as RpcResponse
}

describe('RpcDispatcher', () => {
  it('responds to host.hello', async () => {
    const { dispatcher, written } = makeDispatcher()
    registerHostMethods(dispatcher)

    await dispatcher.feed(encodeFrame({ jsonrpc: '2.0', id: 1, method: 'host.hello' }))

    const [response] = decodeAll(written)
    expect(response).toMatchObject({ jsonrpc: '2.0', id: 1 })
    const result = asResponse(response!).result as { message: string }
    expect(result.message).toBe('hello from extension host')
  })

  it('responds to host.ping', async () => {
    const { dispatcher, written } = makeDispatcher()
    registerHostMethods(dispatcher)

    await dispatcher.feed(encodeFrame({ jsonrpc: '2.0', id: 2, method: 'host.ping' }))

    const [response] = decodeAll(written)
    const result = asResponse(response!).result as { pong: boolean }
    expect(result.pong).toBe(true)
  })

  it('returns a method-not-found error for unknown methods', async () => {
    const { dispatcher, written } = makeDispatcher()

    await dispatcher.feed(encodeFrame({ jsonrpc: '2.0', id: 3, method: 'nope' }))

    const [response] = decodeAll(written)
    expect(asResponse(response!).error?.code).toBe(-32601)
  })

  it('returns an error response when a handler throws', async () => {
    const { dispatcher, written } = makeDispatcher()
    dispatcher.register('boom', () => {
      throw new Error('kaboom')
    })

    await dispatcher.feed(encodeFrame({ jsonrpc: '2.0', id: 4, method: 'boom' }))

    const [response] = decodeAll(written)
    expect(asResponse(response!).error).toEqual({ code: -32000, message: 'kaboom' })
  })

  it('invokes notification handlers without writing a response', async () => {
    const { dispatcher, written } = makeDispatcher()
    const onNotify = vi.fn()
    dispatcher.register('host.log', onNotify)

    await dispatcher.feed(encodeFrame({ jsonrpc: '2.0', method: 'host.log', params: { message: 'hi' } }))

    expect(onNotify).toHaveBeenCalledWith({ message: 'hi' })
    expect(written).toHaveLength(0)
  })

  it('handles frames split across multiple feed calls', async () => {
    const { dispatcher, written } = makeDispatcher()
    registerHostMethods(dispatcher)

    const frame = encodeFrame({ jsonrpc: '2.0', id: 5, method: 'host.ping' })
    const mid = Math.floor(frame.length / 2)
    await dispatcher.feed(frame.subarray(0, mid))
    expect(written).toHaveLength(0)
    await dispatcher.feed(frame.subarray(mid))

    const [response] = decodeAll(written)
    expect(response).toMatchObject({ id: 5 })
  })
})
