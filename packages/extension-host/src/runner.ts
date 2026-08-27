import { createElement, type ReactElement } from 'react'
import { createRequire } from 'node:module'
import {
  mount,
  invokeCallback as invokeReconcilerCallback,
  setHostBridge,
  setCommandContext,
  getCommandContext,
  runInCommandContext,
  setCacheRootDirectory,
  setWindowMounter,
  type MountHandle,
  type HostBridge,
  type CommandContext,
  type Capabilities,
  type WindowMounter,
  type ExtensionWindowOptions,
} from '@openray/api-shim/runtime'
import type { JsonValue } from '@openray/protocol'
import type { RpcDispatcher } from './rpc'
import { log } from './rpc'

/** `infrastructure::window::PALETTE_WINDOW_LABEL` on the Rust side — every
 * `ui.commit` needs a `windowLabel` now (T24), and the palette's own mount
 * variants (`runCommand`/`runRootCommandView`) tag theirs with this literal
 * rather than importing a constant across the Rust/TS boundary. */
const PALETTE_WINDOW_LABEL = 'main'

// createRequire(import.meta.url) is NOT an option here: this file is
// authored as ESM but bundled to CJS output, where import.meta is always
// empty (confirmed empirically — esbuild warns and produces `undefined`).
// __filename is the real CJS global esbuild injects correctly for CJS
// output regardless of the source's own module syntax.
const requireCommand = createRequire(__filename)

interface RunCommandParams {
  extensionId: string
  commandName: string
  commandPath: string
  preferences?: Record<string, unknown>
  /** The argument-bar's collected value(s), keyed by the manifest's
   * declared argument name — absent when the command declares no
   * `arguments[]`, or none were collected. */
  arguments?: Record<string, unknown>
  environment: {
    raycastVersion: string
    assetsPath: string
    supportPath: string
    isDevelopment: boolean
    theme: 'light' | 'dark'
  }
  /** Resolved once by `extension_commands::launch` (see
   * `platform_info.rs`'s doc comment for why this isn't a live bridge
   * call) — matches Rust's `PlatformInfo` struct shape exactly, with
   * `capabilities` nested inside; split into `CommandContext`'s separate
   * `platform`/`capabilities` fields below. */
  platform: {
    os: 'linux' | 'macos' | 'windows'
    displayServer: 'x11' | 'wayland' | null
    capabilities: Capabilities
  }
}

interface InvokeCallbackParams {
  callbackId: string
  args?: unknown[]
}

interface UnmountCommandParams {
  extensionId: string
  commandName: string
}

/** T14: a `root-provider` command's listing request. No `arguments` —
 * listing functions take no launch props, unlike a mounted command. */
interface RunRootProviderListParams {
  extensionId: string
  commandName: string
  commandPath: string
  preferences?: Record<string, unknown>
  environment: RunCommandParams['environment']
  platform: RunCommandParams['platform']
}

/** T21: one query's worth of inline-row work — sent as an
 * `extension.onQuery` *request* (Rust awaits the reply directly, unlike
 * `runRootProviderList`'s two-notification shape, since a per-keystroke
 * round trip has no listing to separately push back). */
interface RunOnQueryParams {
  extensionId: string
  commandName: string
  commandPath: string
  preferences?: Record<string, unknown>
  environment: RunCommandParams['environment']
  platform: RunCommandParams['platform']
  query: string
  /** The user's alias mapping for this extension's own commands/rows —
   * keyed by the opaque id/host command name (the suffix after
   * `ext:{extensionId}:`), not the full id. */
  context: { aliases: Record<string, string> }
}

/** T14: activates one dynamically-contributed row. `commandName` here is
 * always the *host* root-provider command's own name (never the row's
 * opaque id) — `rowId` carries that separately. Also the params shape
 * for T20's `extension.runRootCommandView` — Rust sends the identical
 * payload either way and picks the RPC method by the row's `opens_view`
 * flag (`extension_commands::launch_root_command`). */
interface RunRootCommandParams {
  extensionId: string
  commandName: string
  commandPath: string
  preferences?: Record<string, unknown>
  environment: RunCommandParams['environment']
  platform: RunCommandParams['platform']
  rowId: string
  argument?: string
}

function asRecord(params: unknown): Record<string, unknown> {
  if (params && typeof params === 'object') return params as Record<string, unknown>
  throw new Error('expected an object params payload')
}

/**
 * Keyed by `${extensionId}:${commandName}` rather than an opaque mount id
 * generated per launch — the frontend/Rust side already has both of those
 * identifiers from the launch call, so unmounting a specific command
 * (`extension.unmountCommand`) needs no new identifier threaded through
 * the IPC boundary. A second launch of the *same* command still replaces
 * its own previous mount (matches the pre-T9 behavior for that one case);
 * launching a *different* command no longer touches this map's other
 * entries at all — that unconditional tear-down of whatever was mounted
 * before it was the actual bug T9 fixes.
 */
const mounts = new Map<string, MountHandle>()

function mountKey(extensionId: string, commandName: string): string {
  return `${extensionId}:${commandName}`
}

/**
 * The most recently mounted command's context — re-entered around every
 * `extension.invokeCallback` dispatch (a user clicking a button, typing
 * into a field, submitting a form) to close the gap `command-context.ts`'s
 * module doc describes: `setCommandContext`'s `AsyncLocalStorage.enterWith`
 * only binds to the *mounting* call's own async chain, which has already
 * fully settled by the time a later, independently-dispatched callback
 * fires — so without this, `getCommandContext()` inside a callback (e.g.
 * an extension's `onSubmit` handler calling `refreshRootCommands()` or
 * `LocalStorage`) sees the module's safe fallback (`extensionId:
 * "unknown"`), not the mounted command's real identity. Matches the "only
 * one view is ever visibly interactive" assumption that doc comment
 * already accepted — tracking one most-recent context, not a full
 * per-callback-id owner map, is enough under that model.
 */
let lastMountedContext: CommandContext | undefined

/**
 * Wires the T21 imperative APIs' HostBridge to this dispatcher's outbound
 * `call()` — every `getHostBridge().call(method, params)` inside api-shim
 * ends up as a real RPC request to Rust over the same stdio channel.
 */
function installHostBridge(dispatcher: RpcDispatcher): void {
  const bridge: HostBridge = {
    call: (method, params) => dispatcher.call(method, params as JsonValue | undefined),
  }
  setHostBridge(bridge)
}

/** Shared by every launch variant (`runCommand`/`runRootProviderList`/
 * `runRootCommand`) — they all carry the identical `environment`/
 * `platform`/`preferences` shape. */
function buildCommandContext(params: {
  extensionId: string
  commandName: string
  preferences?: Record<string, unknown>
  environment: RunCommandParams['environment']
  platform: RunCommandParams['platform']
}): CommandContext {
  return {
    extensionId: params.extensionId,
    commandName: params.commandName,
    preferences: params.preferences ?? {},
    raycastVersion: params.environment.raycastVersion,
    assetsPath: params.environment.assetsPath,
    supportPath: params.environment.supportPath,
    isDevelopment: params.environment.isDevelopment,
    theme: params.environment.theme,
    platform: { os: params.platform.os, displayServer: params.platform.displayServer },
    capabilities: params.platform.capabilities,
  }
}

/** Fresh `require`, discarding any cached module — every launch variant
 * needs this so a long-lived sidecar process never lets one run's
 * top-level module state (or a crash mid-evaluation) leak into the next. */
function requireFreshCommandModule(commandPath: string): { default?: unknown; execute?: unknown; view?: unknown; onQuery?: unknown } {
  const resolved = requireCommand.resolve(commandPath)
  delete requireCommand.cache[resolved]
  return requireCommand(commandPath) as { default?: unknown; execute?: unknown; view?: unknown; onQuery?: unknown }
}

/**
 * Real Raycast lets a `no-view`-mode command's default export be a plain
 * (often `async`) function instead of a React component — this codebase's
 * own first-party no-view commands all happened to be written as
 * components instead (`function X() { useEffect(...); return null }`,
 * e.g. `extensions/notes/src/toggle-notes.ts`), which masked the gap:
 * mounting *those* through the reconciler is still correct (and required
 * — they use real hooks), so the fix can't key off manifest `mode` alone.
 * Found live (T32): a real, unmodified store-installed extension (`8ball`,
 * `export default async function Command() {...}`) silently never
 * completed — `mount(createElement(Command, ...), ...)` handed the
 * reconciler a function whose call returns a `Promise`, not a valid
 * render return value, and nothing ever awaited that promise to
 * completion or surfaced its eventual rejection. An `async function` can
 * never be a valid React/reconciler component regardless of mode (the
 * synchronous render contract doesn't allow it), so that's the actual,
 * precise signal to call it directly instead of mounting it — not `mode`,
 * which a legitimate hook-using no-view command (like `toggle-notes`
 * above) also declares.
 */
async function runCommand(dispatcher: RpcDispatcher, params: RunCommandParams): Promise<void> {
  const key = mountKey(params.extensionId, params.commandName)

  const existing = mounts.get(key)
  if (existing) {
    log(`re-launching ${key}: unmounting its previous instance first`)
    existing.unmount()
    mounts.delete(key)
  }

  const context = buildCommandContext(params)
  setCommandContext(context)
  lastMountedContext = context
  setCacheRootDirectory(params.environment.supportPath)

  const Command = requireFreshCommandModule(params.commandPath).default
  if (typeof Command !== 'function') {
    throw new Error(`${params.commandPath} has no default export function`)
  }

  // Real Raycast always passes a LaunchProps-shaped object as the command
  // function's first argument, even when the manifest declares no
  // `arguments[]` — `arguments` defaults to `{}` rather than being absent,
  // so a command destructuring `{ arguments: { foo } }` never throws.
  const launchProps = { arguments: params.arguments ?? {} }

  if (Command.constructor.name === 'AsyncFunction') {
    await (Command as (props: typeof launchProps) => Promise<unknown>)(launchProps)
    return
  }

  const handle = mount(createElement(Command as never, launchProps as never), (commit) => {
    dispatcher.notify('ui.commit', { windowLabel: PALETTE_WINDOW_LABEL, commit } as unknown as JsonValue)
  })
  mounts.set(key, handle)
}

/**
 * Tears down one specific mounted command — the frontend sends this on
 * every view-exit path (back/close) instead of relying on the *next*
 * `runCommand` call to implicitly clean up, since with concurrent mounts
 * there might not be a next call for a long time, or ever, for a
 * no-view/background command. Silently a no-op if the command isn't
 * mounted (already unmounted, or never was) — the frontend doesn't track
 * mount state precisely enough to guarantee it only ever calls this once
 * per real mount, and a duplicate call must not throw.
 */
function unmountCommand(params: UnmountCommandParams): void {
  const key = mountKey(params.extensionId, params.commandName)
  const handle = mounts.get(key)
  if (!handle) {
    log(`unmountCommand: no mount found for ${key} (already unmounted, or never mounted)`)
    return
  }
  handle.unmount()
  mounts.delete(key)
}

function invokeCallback(params: InvokeCallbackParams): void {
  const run = () => invokeReconcilerCallback(params.callbackId, params.args ?? [])
  if (lastMountedContext) runInCommandContext(lastMountedContext, run)
  else run()
}

/**
 * T14: requests a `root-provider` command's listing — no mount, no
 * reconciler. Requires the command module fresh (same as `runCommand`,
 * same reason) and calls its *default* export directly as a plain
 * function, once, awaiting whatever it returns. Whatever comes back
 * (even on a throw, which resolves to `[]` rather than dropping the
 * extension's contribution silently forever) is pushed straight back as
 * `extension.rootCommands` — Rust validates the shape on arrival (see
 * `extension_bridge.rs::root_commands_pushed`), so nothing here needs to.
 */
async function runRootProviderList(dispatcher: RpcDispatcher, params: RunRootProviderListParams): Promise<void> {
  setCommandContext(buildCommandContext(params))
  setCacheRootDirectory(params.environment.supportPath)

  const mod = requireFreshCommandModule(params.commandPath)
  const listCommands = mod.default
  if (typeof listCommands !== 'function') {
    throw new Error(`${params.commandPath} has no default export function (a root-provider command must export a plain listing function)`)
  }

  let commands: unknown = []
  try {
    commands = await (listCommands as () => Promise<unknown>)()
  } catch (error) {
    log(`root-provider listing for ${params.extensionId}:${params.commandName} threw: ${error instanceof Error ? error.message : String(error)}`)
  }

  // T21: whether this module also exports `onQuery` — a fact about its
  // actual exports, checked here (where the module is required fresh
  // anyway) rather than added as a manifest field, and piggybacked onto
  // the same push the listing itself already makes rather than opening a
  // separate round trip just to report one boolean.
  const supportsInlineQuery = typeof mod.onQuery === 'function'

  dispatcher.notify('extension.rootCommands', {
    extensionId: params.extensionId,
    commandName: params.commandName,
    commands,
    supportsInlineQuery,
  } as unknown as JsonValue)
}

/**
 * T21: answers one `onQuery` request for a root-provider row's inline
 * contribution. Requires the module fresh, same as every other launch
 * variant — an inline provider wanting state across calls (e.g. T23's
 * currency-rate cache) needs the same `globalThis`-backed session pattern
 * T18's `provider.ts` established, for the identical reason: this module
 * instance is thrown away right after this call returns.
 */
async function runOnQuery(params: RunOnQueryParams): Promise<JsonValue> {
  setCommandContext(buildCommandContext(params))
  setCacheRootDirectory(params.environment.supportPath)

  const onQuery = requireFreshCommandModule(params.commandPath).onQuery
  if (typeof onQuery !== 'function') {
    throw new Error(`${params.commandPath} has no named "onQuery" export`)
  }

  const row = await (onQuery as (query: string, context: RunOnQueryParams['context']) => Promise<unknown>)(params.query, params.context)
  return (row ?? null) as JsonValue
}

/**
 * T14: activates one dynamically-contributed row — calls the host
 * command's *named* `execute` export (not its default export, which is
 * the listing function `runRootProviderList` calls instead) with the
 * row's own opaque id and the argument-bar value, if any.
 */
async function runRootCommand(params: RunRootCommandParams): Promise<void> {
  setCommandContext(buildCommandContext(params))
  setCacheRootDirectory(params.environment.supportPath)

  const execute = requireFreshCommandModule(params.commandPath).execute
  if (typeof execute !== 'function') {
    throw new Error(`${params.commandPath} has no named "execute" export (required for a root-provider command's rows to activate)`)
  }

  await (execute as (id: string, argument?: string) => Promise<void>)(params.rowId, params.argument)
}

/**
 * T20: mounts a root-provider row's `view` export — the counterpart to
 * `runCommand` for a contributed row, needed because a plain
 * `mode: "root-provider"` command's `execute` export (what
 * `runRootCommand` calls) is headless by construction and can never
 * render anything. Reuses the exact same `mounts` map and `mountKey`
 * shape `runCommand`/`unmountCommand` already use — keyed by
 * `${extensionId}:${rowId}`, which is exactly what the frontend already
 * sends as `commandName` when unmounting a root-provider row (see
 * `App.tsx`'s `launchExtensionCommand`/`unmountExtensionCommand`, and
 * `extension_commands::launch_root_command`'s doc comment on the Rust
 * side) — so `unmountCommand` needs no changes at all to tear this down.
 */
function runRootCommandView(dispatcher: RpcDispatcher, params: RunRootCommandParams): void {
  const key = mountKey(params.extensionId, params.rowId)

  const existing = mounts.get(key)
  if (existing) {
    log(`re-launching ${key}: unmounting its previous instance first`)
    existing.unmount()
    mounts.delete(key)
  }

  const context = buildCommandContext(params)
  setCommandContext(context)
  lastMountedContext = context
  setCacheRootDirectory(params.environment.supportPath)

  const View = requireFreshCommandModule(params.commandPath).view
  if (typeof View !== 'function') {
    throw new Error(`${params.commandPath} has no named "view" export (required for a root-provider row with opensView: true to mount)`)
  }

  const launchProps = { id: params.rowId, argument: params.argument }
  const handle = mount(createElement(View as never, launchProps as never), (commit) => {
    dispatcher.notify('ui.commit', { windowLabel: PALETTE_WINDOW_LABEL, commit } as unknown as JsonValue)
  })
  mounts.set(key, handle)
}

/**
 * T24: mounts kept independently of the `mounts` map above — keyed by
 * window label rather than `${extensionId}:${commandName}`, since an
 * extension window's tree isn't a "launch" the frontend re-triggers by
 * command identity, it's a handle the extension code itself owns and
 * closes explicitly (`ExtensionWindowHandle.close()`) or that gets torn
 * down when Rust reports the native window destroyed
 * (`extension.windowClosed`, e.g. the user clicking its close button).
 */
const windowMounts = new Map<string, MountHandle>()

/**
 * Resolved once Rust confirms the new window's own page has attached its
 * `extension-ui-commit` listener (`extension.windowReady`) — see
 * `infrastructure::window::open_extension_window`'s doc comment for why
 * this handoff exists: without it, the tree's first commit (always a full
 * `snapshot`) could be emitted before the page has finished loading and be
 * lost for good.
 */
const pendingWindowReady = new Map<string, () => void>()

/**
 * `ExtensionWindowOptions.onClose` callbacks, keyed by window label —
 * can't be included in the `host.extensionWindow.open` RPC payload itself
 * (functions aren't JSON-serializable), so it's captured here once the
 * label comes back and fired from `handleWindowClosed` instead. Cleared
 * without firing when this side initiates the close itself (see the
 * `close()` handle below) — the callback exists solely to tell a
 * single-instance-reuse extension its *externally* destroyed window went
 * stale.
 */
const windowCloseCallbacks = new Map<string, () => void>()

function waitForWindowReady(windowLabel: string): Promise<void> {
  return new Promise((resolve) => {
    pendingWindowReady.set(windowLabel, resolve)
  })
}

function handleWindowReady(params: { windowLabel: string }): void {
  const resolve = pendingWindowReady.get(params.windowLabel)
  if (!resolve) {
    log(`extension.windowReady: no pending open for '${params.windowLabel}' (already resolved, or never opened)`)
    return
  }
  pendingWindowReady.delete(params.windowLabel)
  resolve()
}

/**
 * The native window was destroyed (user closed it, or `.close()` closed it
 * from this side and the resulting `WindowEvent::Destroyed` round-tripped
 * back) — tears the mount down if it's still up. A no-op if this side
 * already unmounted it via `ExtensionWindowHandle.close()`, matching
 * `unmountCommand`'s own "duplicate teardown must not throw" contract.
 */
function handleWindowClosed(params: { windowLabel: string }): void {
  const handle = windowMounts.get(params.windowLabel)
  if (handle) {
    handle.unmount()
    windowMounts.delete(params.windowLabel)
  }
  const onClose = windowCloseCallbacks.get(params.windowLabel)
  if (onClose) {
    windowCloseCallbacks.delete(params.windowLabel)
    onClose()
  }
}

function installWindowMounter(dispatcher: RpcDispatcher): void {
  const mounter: WindowMounter = {
    async open(element: ReactElement, options: ExtensionWindowOptions) {
      // Captured synchronously, before any `await` — this is the
      // originating command's own live context (e.g. `toggle-notes`,
      // still on its own synchronous call stack), the same reliability
      // `runCommand` already gets for free. Without this, a window mount
      // never calls `setCommandContext` at all, so *every* effect inside
      // it — not just the ones React's scheduler already can't bind (see
      // `command-context.ts`'s doc comment) — falls through to whichever
      // context `lastContextSlot` happens to hold, which any concurrently
      // refreshing root-provider (`runRootProviderList` below also calls
      // `setCommandContext`) can silently overwrite in the gap between
      // this call and the window's first render. Found live (T26): a
      // freshly created note's own window intermittently read/write under
      // the wrong extension's storage and got stuck showing its initial
      // loading placeholder forever.
      const context = getCommandContext()

      const { onClose, ...rpcOptions } = options
      const result = await dispatcher.call('host.extensionWindow.open', rpcOptions as unknown as JsonValue)
      if (typeof result !== 'string') {
        throw new Error('host.extensionWindow.open did not return a window label')
      }
      const windowLabel = result
      if (onClose) windowCloseCallbacks.set(windowLabel, onClose)

      // Wait for the page to confirm it's listening before this mount's
      // very first commit (always a full snapshot) can be emitted — see
      // `pendingWindowReady`'s doc comment.
      await waitForWindowReady(windowLabel)

      // Re-bound right before `mount()` (not just captured above) since
      // the two awaits above are exactly the kind of gap a concurrent
      // root-provider refresh can land in — matches `runCommand`'s own
      // "set immediately before mount" placement.
      setCommandContext(context)
      const handle = mount(element, (commit) => {
        dispatcher.notify('ui.commit', { windowLabel, commit } as unknown as JsonValue)
      })
      windowMounts.set(windowLabel, handle)

      return {
        close: () => {
          if (windowMounts.delete(windowLabel)) handle.unmount()
          windowCloseCallbacks.delete(windowLabel)
          void dispatcher.call('host.extensionWindow.close', { windowLabel } as unknown as JsonValue)
        },
        focus: () => {
          void dispatcher.call('host.extensionWindow.focus', { windowLabel } as unknown as JsonValue)
        },
      }
    },
  }
  setWindowMounter(mounter)
}

export function registerRunnerMethods(dispatcher: RpcDispatcher): void {
  installHostBridge(dispatcher)
  installWindowMounter(dispatcher)

  dispatcher.register('extension.windowReady', (params) => {
    handleWindowReady(asRecord(params) as unknown as { windowLabel: string })
    return null
  })

  dispatcher.register('extension.windowClosed', (params) => {
    handleWindowClosed(asRecord(params) as unknown as { windowLabel: string })
    return null
  })

  dispatcher.register('extension.runCommand', async (params) => {
    await runCommand(dispatcher, asRecord(params) as unknown as RunCommandParams)
    return null
  })

  dispatcher.register('extension.unmountCommand', (params) => {
    unmountCommand(asRecord(params) as unknown as UnmountCommandParams)
    return null
  })

  dispatcher.register('extension.invokeCallback', (params) => {
    invokeCallback(asRecord(params) as unknown as InvokeCallbackParams)
    return null
  })

  dispatcher.register('extension.runRootProviderList', async (params) => {
    await runRootProviderList(dispatcher, asRecord(params) as unknown as RunRootProviderListParams)
    return null
  })

  dispatcher.register('extension.runRootCommand', async (params) => {
    await runRootCommand(asRecord(params) as unknown as RunRootCommandParams)
    return null
  })

  dispatcher.register('extension.runRootCommandView', (params) => {
    runRootCommandView(dispatcher, asRecord(params) as unknown as RunRootCommandParams)
    return null
  })

  dispatcher.register('extension.onQuery', async (params) => {
    return runOnQuery(asRecord(params) as unknown as RunOnQueryParams)
  })
}
