import { globalSlot } from './global-slot'

/**
 * The imperative APIs (Clipboard, LocalStorage, Toast, ...) run inside the
 * Node sidecar and need Rust for OS access and SQLite persistence. This is
 * the seam: the sidecar's RPC client (packages/extension-host) injects the
 * real bridge once at startup via `setHostBridge`; tests inject a mock
 * directly. Nothing in src/api/* talks to stdio or the RPC framing itself —
 * that's deliberately kept out of this package, which only knows about
 * `call(method, params)`.
 *
 * Backed by a `globalThis` slot (see global-slot.ts), not a plain module
 * variable: `setHostBridge` is called from runner.ts, which lives in
 * host.cjs's own bundle, while `getHostBridge` is called from extension
 * code, compiled as a *separate* bundle that inlines its own copy of this
 * file via the `@raycast/api` alias. A plain `let currentBridge` would be
 * two different variables at runtime — confirmed empirically ("No host
 * bridge configured" even right after `setHostBridge` ran).
 */
export interface HostBridge {
  call(method: string, params?: unknown): Promise<unknown>
}

const bridgeSlot = globalSlot<HostBridge>('hostBridge')

export function setHostBridge(bridge: HostBridge): void {
  bridgeSlot.set(bridge)
}

export function getHostBridge(): HostBridge {
  const bridge = bridgeSlot.get()
  if (!bridge) {
    throw new Error('No host bridge configured — call setHostBridge() before using imperative Raycast APIs')
  }
  return bridge
}

/** Test-only: clears the bridge so each test starts from a known state. */
export function _resetHostBridgeForTests(): void {
  bridgeSlot.clear()
}
