import { AsyncLocalStorage } from 'node:async_hooks'
import { globalSlot } from '../global-slot'

/**
 * `getPreferenceValues()` and `environment` are synchronous in the real
 * Raycast API — extensions read them at module top level, before any await
 * point. Since fetching them requires an RPC round trip, they can't be
 * fetched lazily on first read; the command driver (runner.ts) must resolve
 * them once via `getHostBridge().call(...)` and call `setCommandContext`
 * before evaluating the command module at all.
 *
 * Backed by an `AsyncLocalStorage` (not a plain mutable slot) so two
 * commands mounted concurrently in the same sidecar process (T9) don't
 * corrupt each other's context. A plain `let current = context` would mean
 * the *second* `setCommandContext` call silently overwrites the first for
 * every callback the first command has already scheduled — its still-alive
 * `useEffect`/`setInterval` timers, and anything reading `getPreferenceValues()`
 * or `LocalStorage` (namespaced by `getCommandContext().extensionId` on
 * every call, not just at mount) would then see the *wrong* command's data.
 * `AsyncLocalStorage.enterWith` binds the context to the current
 * synchronous execution and everything scheduled from it (timers, promise
 * continuations) — the same mechanism Node HTTP frameworks use to isolate
 * concurrent request context — so each mounted command's context stays
 * correct regardless of what other commands mount afterward.
 *
 * The one gap this doesn't close: an action callback invoked later via
 * `extension.invokeCallback` (a user clicking a list item, say) runs on
 * whatever async chain the RPC dispatcher's message handler is on, not
 * the originating mount's chain — so `getCommandContext()` inside such a
 * callback sees whichever command most recently mounted, not necessarily
 * the callback's own owner. Accepted for now: only one view is ever
 * visibly interactive in the palette model this phase operates in, so a
 * background-mounted command's callbacks aren't reachable by the user
 * without also being the foreground (and thus most-recently-mounted) one.
 * Revisit if a later phase makes two mounted commands simultaneously
 * interactive (e.g. an extension-owned window alongside the palette).
 *
 * The `AsyncLocalStorage` instance itself is stored behind a `globalThis`
 * slot (see global-slot.ts) for the same cross-bundle reason as
 * bridge.ts/hooks.ts/cache.ts: `setCommandContext` runs in host.cjs's
 * bundle (runner.ts), `getCommandContext` in the extension's
 * separately-compiled bundle — a plain module-level `AsyncLocalStorage`
 * instance would be two different instances at runtime.
 *
 * Falls back to a safe default so a stray top-level read doesn't crash
 * import — the exact failure mode found in an earlier spike (a stub Proxy
 * used in a template literal throws on ToPrimitive coercion).
 */
export interface PlatformInfo {
  os: 'linux' | 'macos' | 'windows'
  displayServer: 'x11' | 'wayland' | null
}

export interface Capabilities {
  selectionRead: boolean
  dropAtCursor: boolean
  multiFormatClipboard: boolean
  menuBarIntrospection: boolean
  windowControl: boolean
}

export interface CommandContext {
  extensionId: string
  commandName: string
  preferences: Record<string, unknown>
  raycastVersion: string
  assetsPath: string
  supportPath: string
  isDevelopment: boolean
  theme: 'light' | 'dark'
  platform: PlatformInfo
  capabilities: Capabilities
}

// A conservative "we don't actually know" default — every capability
// false rather than true, since a stray top-level read (see this module's
// doc comment on the Proxy/ToPrimitive failure mode this guards against)
// must never claim a capability that might not really be there.
const fallback: CommandContext = {
  extensionId: 'unknown',
  commandName: 'unknown',
  preferences: {},
  raycastVersion: '1.0.0',
  assetsPath: '',
  supportPath: '',
  isDevelopment: true,
  theme: 'light',
  platform: { os: 'linux', displayServer: null },
  capabilities: {
    selectionRead: false,
    dropAtCursor: false,
    multiFormatClipboard: false,
    menuBarIntrospection: false,
    windowControl: false,
  },
}

const storageSlot = globalSlot<AsyncLocalStorage<CommandContext>>('commandContextStorage')
/** T26: the most recently `setCommandContext`-bound context, independent
 *  of `AsyncLocalStorage`'s own causal-chain tracking — see
 *  `getCommandContext`'s doc comment for why this exists as a second-tier
 *  fallback, not a replacement for the `AsyncLocalStorage` lookup. */
const lastContextSlot = globalSlot<CommandContext>('lastCommandContext')

function storage(): AsyncLocalStorage<CommandContext> {
  let instance = storageSlot.get()
  if (!instance) {
    instance = new AsyncLocalStorage()
    storageSlot.set(instance)
  }
  return instance
}

/**
 * Binds `context` to the current synchronous execution (and everything
 * scheduled from it) — see the module doc comment. Call this immediately
 * before mounting the command whose context this is; anything the mount
 * does synchronously, or asynchronously as a result, sees this context.
 */
export function setCommandContext(context: CommandContext): void {
  storage().enterWith(context)
  lastContextSlot.set(context)
}

/**
 * `AsyncLocalStorage.getStore()` first, then the most recently
 * `setCommandContext`-bound context, then the hardcoded safe default —
 * only the first tier is genuinely scoped to "the mount this call is
 * causally descended from"; the second is the same "single foreground
 * view" fallback this module's own doc comment already accepts for
 * `extension.invokeCallback`, applied one level more broadly.
 *
 * Found live (T26): a no-view command's own `useEffect` calling
 * `LocalStorage`/other imperative APIs saw the *hardcoded* `unknown`
 * fallback, not the mounting command's real identity — three notes were
 * silently written under extension id `"unknown"` before this fix. React's
 * passive-effect flush goes through `react-reconciler`'s own internal
 * `Scheduler` (a `MessageChannel`/`setTimeout`-based queue this package's
 * host config doesn't own or get a hook into — `scheduleTimeout` here is a
 * different, unrelated host-config callback), so unlike `invokeCallback`'s
 * documented gap (an *externally* RPC-dispatched callback), this one
 * isn't something `runner.ts` can re-bind around a specific call site —
 * every scheduled effect from every mount needs the same fallback, which
 * is exactly what "most recent mount" already models.
 */
export function getCommandContext(): CommandContext {
  return storage().getStore() ?? lastContextSlot.get() ?? fallback
}

/**
 * Runs `fn` bound to `context`, restoring whatever context (if any) was
 * active before `fn` returns — unlike `setCommandContext`, which persists
 * for the rest of the current async chain. Not currently used by
 * `runner.ts` (which wants persistence through the mounted command's
 * lifetime, not a scoped call), but available for a narrower future use
 * (e.g. explicitly restoring a specific mount's context around a single
 * callback invocation, closing this module's documented callback-context
 * gap above).
 */
export function runInCommandContext<T>(context: CommandContext, fn: () => T): T {
  return storage().run(context, fn)
}

/** Test-only: restores the fallback context between tests. `AsyncLocalStorage`
 * has no explicit "clear" — running outside any `.enterWith`/`.run` scope
 * already returns `undefined` from `getStore()`, which falls back safely;
 * this just re-enters a **fresh, empty store instance** so a previous
 * test's `enterWith` call (which persists for the rest of *that* test's
 * synchronous+async chain) can't leak into the next test via a shared
 * instance. Also clears `lastContextSlot` (T26) — otherwise a previous
 * test's `setCommandContext` call leaks through *that* fallback tier
 * instead, the exact regression this reset guards against one layer
 * deeper than before. */
export function _resetCommandContextForTests(): void {
  storageSlot.set(new AsyncLocalStorage())
  lastContextSlot.clear()
}
