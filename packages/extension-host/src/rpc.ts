import {
  encodeFrame,
  FrameDecoder,
  isRpcNotification,
  isRpcRequest,
  isRpcResponse,
  type JsonValue,
  type RpcMessage,
} from '@openray/protocol'

export type MethodHandler = (params: JsonValue | undefined) => JsonValue | Promise<JsonValue>

class RpcRemoteError extends Error {
  constructor(
    message: string,
    public readonly code: number,
  ) {
    super(message)
    this.name = 'RpcRemoteError'
  }
}

/**
 * Dispatches incoming RPC requests/notifications to registered handlers and
 * writes responses back over stdout, AND lets this side originate its own
 * requests to the peer (Rust) via `call()`. Runs inside the Node sidecar
 * process — stdout is reserved for the binary frame protocol, so handlers
 * and this class must never write plain text there (use `log()`, which
 * goes to stderr).
 */
export class RpcDispatcher {
  private readonly methods = new Map<string, MethodHandler>()
  private readonly decoder = new FrameDecoder()
  private readonly pending = new Map<string | number, { resolve: (v: JsonValue) => void; reject: (e: Error) => void }>()
  private nextCallId = 1

  constructor(
    private readonly write: (bytes: Uint8Array) => void,
    private readonly onNotification?: (method: string, params: JsonValue | undefined) => void,
  ) {}

  register(method: string, handler: MethodHandler): void {
    this.methods.set(method, handler)
  }

  /** Feed raw bytes read from stdin; dispatches any complete frames found. */
  async feed(chunk: Uint8Array): Promise<void> {
    const messages = this.decoder.push(chunk)
    for (const message of messages) {
      await this.dispatch(message)
    }
  }

  private async dispatch(message: RpcMessage): Promise<void> {
    if (isRpcResponse(message)) {
      const waiter = this.pending.get(message.id)
      if (!waiter) return
      this.pending.delete(message.id)
      if (message.error) waiter.reject(new RpcRemoteError(message.error.message, message.error.code))
      else waiter.resolve(message.result ?? null)
      return
    }

    if (isRpcRequest(message)) {
      const handler = this.methods.get(message.method)
      if (!handler) {
        this.write(
          encodeFrame({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32601, message: `Method not found: ${message.method}` },
          }),
        )
        return
      }
      try {
        const result = await handler(message.params)
        this.write(encodeFrame({ jsonrpc: '2.0', id: message.id, result: result ?? null }))
      } catch (error) {
        this.write(
          encodeFrame({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
          }),
        )
      }
      return
    }

    if (isRpcNotification(message)) {
      this.onNotification?.(message.method, message.params)
      const handler = this.methods.get(message.method)
      if (handler) {
        // Unlike a request, a notification has no response to carry an
        // error back on — but an uncaught throw here (sync or a rejected
        // promise) would otherwise propagate straight out of `dispatch`
        // into whatever's reading stdin, which has no catch of its own
        // either. Found live (T20): a `runRootCommandView` mount that
        // throws left the sidecar in an unrecoverable state with zero
        // visible symptom — the frontend just waited forever for a
        // `ui.commit` that was never coming. Log and swallow instead, the
        // same "never let one extension's failure take down anything
        // else" posture every other dispatch path here already has.
        try {
          await handler(message.params)
        } catch (error) {
          log(`notification handler for ${message.method} threw: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
        }
      }
    }
  }

  notify(method: string, params?: JsonValue): void {
    this.write(encodeFrame(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params }))
  }

  /** Sends a request to the peer (Rust) and resolves with its result. */
  call(method: string, params?: JsonValue): Promise<JsonValue> {
    const id = this.nextCallId++
    return new Promise<JsonValue>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.write(
        encodeFrame(params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params }),
      )
    })
  }
}

export function log(message: string): void {
  process.stderr.write(`[extension-host] ${message}\n`)
}
