export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export type RpcId = string | number

export interface RpcRequest {
  jsonrpc: '2.0'
  id: RpcId
  method: string
  params?: JsonValue
}

export interface RpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: JsonValue
}

export interface RpcError {
  code: number
  message: string
  data?: JsonValue
}

export interface RpcResponse {
  jsonrpc: '2.0'
  id: RpcId
  result?: JsonValue
  error?: RpcError
}

export type RpcMessage = RpcRequest | RpcNotification | RpcResponse

export function isRpcRequest(message: RpcMessage): message is RpcRequest {
  return 'id' in message && 'method' in message
}

export function isRpcNotification(message: RpcMessage): message is RpcNotification {
  return !('id' in message) && 'method' in message
}

export function isRpcResponse(message: RpcMessage): message is RpcResponse {
  return 'id' in message && !('method' in message)
}

/**
 * Wire framing: a 4-byte big-endian length prefix followed by that many
 * bytes of UTF-8 JSON. Used for both directions of the Rust <-> Node
 * sidecar stdio pipe.
 */
export function encodeFrame(message: RpcMessage): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(message))
  const frame = new Uint8Array(4 + json.length)
  new DataView(frame.buffer).setUint32(0, json.length, false)
  frame.set(json, 4)
  return frame
}

export class FrameDecoder {
  private buffer: Uint8Array = new Uint8Array(0)

  push(chunk: Uint8Array): RpcMessage[] {
    const merged = new Uint8Array(this.buffer.length + chunk.length)
    merged.set(this.buffer, 0)
    merged.set(chunk, this.buffer.length)
    this.buffer = merged

    const messages: RpcMessage[] = []
    for (;;) {
      if (this.buffer.length < 4) break
      const length = new DataView(this.buffer.buffer, this.buffer.byteOffset, 4).getUint32(0, false)
      if (this.buffer.length < 4 + length) break
      const json = new TextDecoder().decode(this.buffer.subarray(4, 4 + length))
      messages.push(JSON.parse(json) as RpcMessage)
      this.buffer = this.buffer.subarray(4 + length)
    }
    return messages
  }
}
