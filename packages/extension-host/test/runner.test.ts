import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { build } from 'esbuild'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { encodeFrame, FrameDecoder, type RpcMessage, type RpcResponse } from '@openray/protocol'
import { RpcDispatcher } from '../src/rpc'
import { registerRunnerMethods } from '../src/runner'

const here = dirname(fileURLToPath(import.meta.url))
const apiShimSrcDir = join(here, '..', '..', 'api-shim', 'src')
const requireFromApiShim = createRequire(join(apiShimSrcDir, 'index.cts'))

// Bundles each .tsx fixture the same way builder.ts bundles a real
// extension command: react aliased to api-shim's own installed copy and
// externalized to that same resolved path. Externalizing (not inlining)
// matters here for the identical reason build.mjs/builder.ts external it —
// this test file's own `import { createElement } from 'react'` (pulled in
// transitively via `../src/runner`) is resolved by vitest's own resolver,
// and unless the fixture's bundled `require('react')` lands on that exact
// same absolute file, hooks break with "Invalid hook call" (two React
// instances, one module-level dispatcher each).
async function bundleFixture(name: string, outDir: string, ext: 'tsx' | 'ts' = 'tsx'): Promise<string> {
  const entry = join(here, 'fixtures', `${name}.${ext}`)
  const outfile = join(outDir, `${name}.js`)
  const reactPath = requireFromApiShim.resolve('react')
  const jsxRuntimePath = requireFromApiShim.resolve('react/jsx-runtime')
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    logLevel: 'silent',
    jsx: 'automatic',
    // Same aliasing builder.ts uses for a real extension command — only
    // fixtures that actually import @raycast/api/@openray/extras need this, but
    // it's harmless for the ones that don't.
    alias: {
      react: reactPath,
      'react/jsx-runtime': jsxRuntimePath,
      '@raycast/api': join(apiShimSrcDir, 'index.cts'),
      '@openray/extras': join(apiShimSrcDir, 'openray.cts'),
    },
    external: [reactPath, jsxRuntimePath],
  })
  return outfile
}

function makeDispatcher() {
  const written: Uint8Array[] = []
  const dispatcher = new RpcDispatcher((bytes) => written.push(bytes))
  return { dispatcher, written }
}

function decodeAll(chunks: Uint8Array[]): RpcMessage[] {
  const decoder = new FrameDecoder()
  return chunks.flatMap((chunk) => decoder.push(chunk))
}

function lastResponse(written: Uint8Array[]): RpcResponse {
  const messages = decodeAll(written)
  return messages[messages.length - 1] as unknown as RpcResponse
}

/** Finds the most recent outbound *notification* (no `id`, e.g.
 * `extension.rootCommands`) for `method` — distinct from `lastResponse`,
 * which only ever looks at the final message (a response to whatever
 * request was just fed in, not necessarily the notification a handler
 * sends as a side effect). */
function lastNotification(written: Uint8Array[], method: string): { method: string; params: unknown } | undefined {
  const messages = decodeAll(written) as unknown as { method?: string; params?: unknown; id?: unknown }[]
  return [...messages].reverse().find((m) => m.method === method && m.id === undefined) as
    | { method: string; params: unknown }
    | undefined
}

function environment() {
  return {
    raycastVersion: '1.0.0',
    assetsPath: '',
    supportPath: '',
    isDevelopment: true,
    theme: 'light' as const,
  }
}

function platform() {
  return {
    os: 'linux' as const,
    displayServer: 'x11' as const,
    capabilities: {
      selectionRead: true,
      dropAtCursor: true,
      multiFormatClipboard: true,
      menuBarIntrospection: true,
      windowControl: true,
    },
  }
}

async function runCommand(
  dispatcher: RpcDispatcher,
  written: Uint8Array[],
  extensionId: string,
  commandName: string,
  commandPath: string,
): Promise<void> {
  await dispatcher.feed(
    encodeFrame({
      jsonrpc: '2.0',
      id: written.length + 1,
      method: 'extension.runCommand',
      params: { extensionId, commandName, commandPath, environment: environment(), platform: platform() },
    }),
  )
  const response = lastResponse(written)
  if (response.error) throw new Error(`runCommand failed: ${response.error.message}`)
}

async function unmountCommand(
  dispatcher: RpcDispatcher,
  written: Uint8Array[],
  extensionId: string,
  commandName: string,
): Promise<void> {
  await dispatcher.feed(
    encodeFrame({
      jsonrpc: '2.0',
      id: written.length + 1,
      method: 'extension.unmountCommand',
      params: { extensionId, commandName },
    }),
  )
  const response = lastResponse(written)
  if (response.error) throw new Error(`unmountCommand failed: ${response.error.message}`)
}

async function runRootProviderList(
  dispatcher: RpcDispatcher,
  written: Uint8Array[],
  extensionId: string,
  commandName: string,
  commandPath: string,
): Promise<void> {
  await dispatcher.feed(
    encodeFrame({
      jsonrpc: '2.0',
      id: written.length + 1,
      method: 'extension.runRootProviderList',
      params: { extensionId, commandName, commandPath, environment: environment(), platform: platform() },
    }),
  )
  const response = lastResponse(written)
  if (response.error) throw new Error(`runRootProviderList failed: ${response.error.message}`)
}

async function runRootCommand(
  dispatcher: RpcDispatcher,
  written: Uint8Array[],
  extensionId: string,
  commandName: string,
  commandPath: string,
  rowId: string,
  argument?: string,
): Promise<void> {
  await dispatcher.feed(
    encodeFrame({
      jsonrpc: '2.0',
      id: written.length + 1,
      method: 'extension.runRootCommand',
      params: { extensionId, commandName, commandPath, rowId, argument: argument ?? null, environment: environment(), platform: platform() },
    }),
  )
  const response = lastResponse(written)
  if (response.error) throw new Error(`runRootCommand failed: ${response.error.message}`)
}

/** T20: mounts a root-provider row's `view` export, mirroring
 * `runRootCommand` but exercising `extension.runRootCommandView`. */
async function runRootCommandView(
  dispatcher: RpcDispatcher,
  written: Uint8Array[],
  extensionId: string,
  commandName: string,
  commandPath: string,
  rowId: string,
  argument?: string,
): Promise<void> {
  await dispatcher.feed(
    encodeFrame({
      jsonrpc: '2.0',
      id: written.length + 1,
      method: 'extension.runRootCommandView',
      params: { extensionId, commandName, commandPath, rowId, argument: argument ?? null, environment: environment(), platform: platform() },
    }),
  )
  const response = lastResponse(written)
  if (response.error) throw new Error(`runRootCommandView failed: ${response.error.message}`)
}

function events(): string[] {
  return ((globalThis as Record<string, unknown>).__fixtureEvents ??= []) as string[]
}

// react-reconciler flushes passive effects (useEffect) asynchronously via
// its own scheduler (setTimeout-based in this host config, see
// reconciler.ts's `scheduleTimeout: setTimeout`), never synchronously
// within mount()/unmount() — every assertion on a fixture's mount/unmount
// side effects needs to wait a tick first.
function flushEffects(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10))
}

describe('runner mount lifecycle', () => {
  let intervalPath: string
  let simplePath: string
  let asyncNoViewPath: string

  beforeAll(async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'openray-runner-test-'))
    intervalPath = await bundleFixture('interval-command', outDir)
    simplePath = await bundleFixture('simple-command', outDir)
    asyncNoViewPath = await bundleFixture('async-no-view-command', outDir, 'ts')
  }, 30_000)

  beforeEach(() => {
    ;(globalThis as Record<string, unknown>).__fixtureEvents = []
  })

  it('mounts a command and unmounts it via extension.unmountCommand, tearing down its interval', async () => {
    const { dispatcher, written } = makeDispatcher()
    registerRunnerMethods(dispatcher)

    await runCommand(dispatcher, written, 'ext-a', 'interval-cmd', intervalPath)
    await flushEffects()
    expect(events()).toContain('interval:mount')

    await new Promise((resolve) => setTimeout(resolve, 30))
    const ticksWhileMounted = events().filter((e) => e === 'interval:tick').length
    expect(ticksWhileMounted).toBeGreaterThan(0)

    await unmountCommand(dispatcher, written, 'ext-a', 'interval-cmd')
    await flushEffects()
    expect(events()).toContain('interval:unmount')

    const countAfterUnmount = events().filter((e) => e === 'interval:tick').length
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(events().filter((e) => e === 'interval:tick').length).toBe(countAfterUnmount)
  })

  it('mounting a different command does not tear down an already-mounted one', async () => {
    const { dispatcher, written } = makeDispatcher()
    registerRunnerMethods(dispatcher)

    await runCommand(dispatcher, written, 'ext-a', 'interval-cmd', intervalPath)
    await flushEffects()
    expect(events()).toContain('interval:mount')

    await runCommand(dispatcher, written, 'ext-b', 'simple-cmd', simplePath)
    await flushEffects()
    expect(events()).toContain('simple:mount')
    expect(events()).not.toContain('interval:unmount')

    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(events().filter((e) => e === 'interval:tick').length).toBeGreaterThan(0)

    await unmountCommand(dispatcher, written, 'ext-a', 'interval-cmd')
    await unmountCommand(dispatcher, written, 'ext-b', 'simple-cmd')
  })

  it('re-launching the same command replaces its own previous mount', async () => {
    const { dispatcher, written } = makeDispatcher()
    registerRunnerMethods(dispatcher)

    await runCommand(dispatcher, written, 'ext-a', 'simple-cmd', simplePath)
    await flushEffects()
    expect(events().filter((e) => e === 'simple:mount').length).toBe(1)

    await runCommand(dispatcher, written, 'ext-a', 'simple-cmd', simplePath)
    await flushEffects()
    expect(events().filter((e) => e === 'simple:mount').length).toBe(2)
    expect(events().filter((e) => e === 'simple:unmount').length).toBe(1)

    await unmountCommand(dispatcher, written, 'ext-a', 'simple-cmd')
  })

  it('unmountCommand on an unmounted command is a silent no-op', async () => {
    const { dispatcher, written } = makeDispatcher()
    registerRunnerMethods(dispatcher)

    await unmountCommand(dispatcher, written, 'ext-nope', 'nope')
  })

  /** T32 regression: a `no-view` command whose default export is a plain
   * `async function` (real Raycast's own documented convention, and
   * exactly the shape a real store-installed extension used) must run to
   * completion by being called directly, not mounted through the
   * reconciler — which can't handle a component call that returns a
   * Promise instead of a valid render value. */
  it('an async-function default export runs to completion instead of being mounted', async () => {
    const { dispatcher, written } = makeDispatcher()
    registerRunnerMethods(dispatcher)

    await runCommand(dispatcher, written, 'ext-c', 'async-no-view-cmd', asyncNoViewPath)

    expect(events()).toEqual(['async-no-view:start', 'async-no-view:done'])
    // Never mounted through the reconciler, so there's nothing for
    // unmountCommand to find — matches its own documented "already
    // unmounted, or never mounted" no-op contract, not an error.
    await unmountCommand(dispatcher, written, 'ext-c', 'async-no-view-cmd')
  })
})

describe('root-provider commands (T14)', () => {
  let rootProviderPath: string

  beforeAll(async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'openray-root-provider-test-'))
    rootProviderPath = await bundleFixture('root-provider-command', outDir, 'ts')
  }, 30_000)

  beforeEach(() => {
    ;(globalThis as Record<string, unknown>).__fixtureEvents = []
  })

  it('runRootProviderList calls the default-exported listing function once and pushes extension.rootCommands', async () => {
    const { dispatcher, written } = makeDispatcher()
    registerRunnerMethods(dispatcher)

    await runRootProviderList(dispatcher, written, 'ext-a', 'list', rootProviderPath)

    expect(events()).toEqual(['list'])
    const notification = lastNotification(written, 'extension.rootCommands')
    expect(notification).toBeDefined()
    expect(notification?.params).toEqual({
      extensionId: 'ext-a',
      commandName: 'list',
      commands: [
        { id: 'row-1', title: 'Row One', requiresArgument: false, needsConfirm: false, opensView: false },
        { id: 'row-2', title: 'Row Two', needsConfirm: true, opensView: false },
      ],
      supportsInlineQuery: false,
    })
  })

  it('leaves zero timers behind — nothing scheduled survives the one-shot call', async () => {
    const { dispatcher, written } = makeDispatcher()
    registerRunnerMethods(dispatcher)

    await runRootProviderList(dispatcher, written, 'ext-a', 'list', rootProviderPath)
    const countRightAfter = events().length

    // A mounted command (T9's interval fixture) keeps producing events on
    // its own; a root-provider call must not — nothing is left running
    // that could push more after the call itself has returned.
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(events().length).toBe(countRightAfter)
  })

  it('runRootCommand calls the named execute export with the row id and argument, not the listing function', async () => {
    const { dispatcher, written } = makeDispatcher()
    registerRunnerMethods(dispatcher)

    await runRootCommand(dispatcher, written, 'ext-a', 'list', rootProviderPath, 'row-2', 'hello')

    expect(events()).toEqual(['execute:row-2:hello'])
  })

  it('a listing function that throws resolves to an empty array instead of losing the extension.rootCommands push', async () => {
    const { dispatcher, written } = makeDispatcher()
    registerRunnerMethods(dispatcher)

    const outDir = mkdtempSync(join(tmpdir(), 'openray-root-provider-throw-test-'))
    const throwingPath = join(outDir, 'throwing.js')
    await build({
      stdin: {
        contents: `export default async function() { throw new Error('boom') }`,
        resolveDir: outDir,
        loader: 'ts',
      },
      outfile: throwingPath,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent',
    })

    await runRootProviderList(dispatcher, written, 'ext-b', 'list', throwingPath)

    const notification = lastNotification(written, 'extension.rootCommands')
    expect(notification?.params).toEqual({ extensionId: 'ext-b', commandName: 'list', commands: [], supportsInlineQuery: false })
  })
})

/** T21: sends `extension.onQuery` and returns the raw RPC response
 * (not just success/failure, unlike the other helpers above) — callers
 * need to inspect `result`/`error` directly. */
async function runOnQuery(
  dispatcher: RpcDispatcher,
  written: Uint8Array[],
  extensionId: string,
  commandName: string,
  commandPath: string,
  query: string,
  aliases: Record<string, string> = {},
): Promise<RpcResponse> {
  await dispatcher.feed(
    encodeFrame({
      jsonrpc: '2.0',
      id: written.length + 1,
      method: 'extension.onQuery',
      params: { extensionId, commandName, commandPath, query, context: { aliases }, environment: environment(), platform: platform() },
    }),
  )
  return lastResponse(written)
}

describe('inline queries (T21)', () => {
  let inlineQueryPath: string

  beforeAll(async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'openray-inline-query-test-'))
    inlineQueryPath = await bundleFixture('inline-query-command', outDir, 'ts')
  }, 30_000)

  beforeEach(() => {
    ;(globalThis as Record<string, unknown>).__fixtureEvents = []
  })

  it('runRootProviderList reports supportsInlineQuery: true for a module exporting onQuery', async () => {
    const { dispatcher, written } = makeDispatcher()
    registerRunnerMethods(dispatcher)

    await runRootProviderList(dispatcher, written, 'ext-c', 'list', inlineQueryPath)

    const notification = lastNotification(written, 'extension.rootCommands')
    expect(notification?.params).toMatchObject({ supportsInlineQuery: true })
  })

  it('extension.onQuery calls the named onQuery export and returns its row as the RPC result', async () => {
    const { dispatcher, written } = makeDispatcher()
    registerRunnerMethods(dispatcher)

    const response = await runOnQuery(dispatcher, written, 'ext-c', 'list', inlineQueryPath, 'hello', { row: 'alias' })

    expect(response.error).toBeUndefined()
    expect(response.result).toEqual({ id: 'echo', title: 'Echo: hello', value: 'hello' })
    expect(events()).toEqual(['onQuery:hello:{"row":"alias"}'])
  })

  it('extension.onQuery resolves to null when the export returns null', async () => {
    const { dispatcher, written } = makeDispatcher()
    registerRunnerMethods(dispatcher)

    const response = await runOnQuery(dispatcher, written, 'ext-c', 'list', inlineQueryPath, '')

    expect(response.error).toBeUndefined()
    expect(response.result).toBeNull()
  })
})

describe('root-provider row views (T20)', () => {
  let rootProviderViewPath: string

  beforeAll(async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'openray-root-provider-view-test-'))
    rootProviderViewPath = await bundleFixture('root-provider-view-command', outDir)
  }, 30_000)

  beforeEach(() => {
    ;(globalThis as Record<string, unknown>).__fixtureEvents = []
  })

  it('runRootCommandView mounts the named view export with {id, argument} as props', async () => {
    const { dispatcher, written } = makeDispatcher()
    registerRunnerMethods(dispatcher)

    await runRootCommandView(dispatcher, written, 'ext-a', 'list', rootProviderViewPath, 'row-1', 'hello')
    await flushEffects()

    expect(events()).toContain('view:mount:row-1:hello')
    await unmountCommand(dispatcher, written, 'ext-a', 'row-1')
    await flushEffects()
  })

  it('unmountCommand tears a mounted row view down, keyed by rowId not the host command name', async () => {
    const { dispatcher, written } = makeDispatcher()
    registerRunnerMethods(dispatcher)

    await runRootCommandView(dispatcher, written, 'ext-a', 'list', rootProviderViewPath, 'row-1')
    await flushEffects()
    expect(events()).toContain('view:mount:row-1:')

    // Matches what the frontend actually sends: `commandName` here is the
    // row id, never the host root-provider command's own name — see
    // `extension_commands::launch_root_command`'s doc comment.
    await unmountCommand(dispatcher, written, 'ext-a', 'row-1')
    await flushEffects()

    expect(events()).toContain('view:unmount:row-1')
  })

  it('mounting a different row does not tear down an already-mounted one', async () => {
    const { dispatcher, written } = makeDispatcher()
    registerRunnerMethods(dispatcher)

    await runRootCommandView(dispatcher, written, 'ext-a', 'list', rootProviderViewPath, 'row-1')
    await flushEffects()
    await runRootCommandView(dispatcher, written, 'ext-a', 'list', rootProviderViewPath, 'row-2')
    await flushEffects()

    expect(events()).toContain('view:mount:row-1:')
    expect(events()).toContain('view:mount:row-2:')
    expect(events()).not.toContain('view:unmount:row-1')

    // Leaving these mounted would leak into the next test — `mounts` is a
    // module-level singleton in runner.ts, not reset per test.
    await unmountCommand(dispatcher, written, 'ext-a', 'row-1')
    await unmountCommand(dispatcher, written, 'ext-a', 'row-2')
    await flushEffects()
  })

  it('re-launching the same row unmounts its previous view instance first', async () => {
    const { dispatcher, written } = makeDispatcher()
    registerRunnerMethods(dispatcher)

    await runRootCommandView(dispatcher, written, 'ext-a', 'list', rootProviderViewPath, 'row-1', 'first')
    await flushEffects()
    await runRootCommandView(dispatcher, written, 'ext-a', 'list', rootProviderViewPath, 'row-1', 'second')
    await flushEffects()

    expect(events()).toEqual(['view:mount:row-1:first', 'view:unmount:row-1', 'view:mount:row-1:second'])
  })
})

/** Finds the registered callback id for `propName` (e.g. `onAction`) on
 * any node in a `ui.commit` snapshot — a serialized function prop is
 * `{__callback: "<id>"}` (see `reconciler.ts::serializeProps`). */
function findCallbackId(snapshot: { nodes: Record<string, { props: Record<string, unknown> }> }, propName: string): string | undefined {
  for (const node of Object.values(snapshot.nodes)) {
    const prop = node.props[propName]
    if (prop && typeof prop === 'object' && '__callback' in prop) return (prop as { __callback: string }).__callback
  }
  return undefined
}

describe('command context survives an async callback dispatched later (T15 regression)', () => {
  let contextCallbackPath: string

  beforeAll(async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'openray-context-callback-test-'))
    contextCallbackPath = await bundleFixture('context-callback-command', outDir)
  }, 30_000)

  /**
   * Caught live, not by a prior unit test: a quicklinks Edit form's
   * `onSubmit` handler called `refreshRootCommands()`, and Rust rejected
   * the request with `extensionId: "unknown"` — `getCommandContext()`
   * inside the fired callback saw `command-context.ts`'s safe fallback
   * instead of the mounted command's real identity. The exact async
   * boundary that produces the fallback in the real sidecar process
   * (verified only by reproducing it live, not reproducible here — a
   * direct `node -e` check showed `AsyncLocalStorage.enterWith` actually
   * persisting across a real `stdin` `data` event, broader than
   * `command-context.ts`'s own doc comment assumed, so this harness's
   * synthetic dispatch never hits the same gap) isn't what this test
   * exercises. What it does verify: `runInCommandContext` (the T15 fix)
   * correctly threads a mounted command's context through to a
   * *separately dispatched* `extension.invokeCallback` call, which is
   * the actual mechanism the fix adds — a real regression in that wiring
   * (e.g. the wrong context object, or the call silently not happening)
   * would still fail this test.
   */
  it("an invoked callback's getCommandContext() reflects the command that registered it, not the fallback", async () => {
    const written: Uint8Array[] = []
    const decoder = new FrameDecoder()
    let capturedExtensionId: unknown
    const dispatcher = new RpcDispatcher((bytes) => {
      written.push(bytes)
      for (const message of decoder.push(bytes) as unknown as { id?: unknown; method?: string; params?: { extensionId?: unknown } }[]) {
        if (message.method === 'host.system.refreshRootCommands' && message.id !== undefined) {
          capturedExtensionId = message.params?.extensionId
          dispatcher.feed(encodeFrame({ jsonrpc: '2.0', id: message.id, result: null } as unknown as never))
        }
      }
    })
    registerRunnerMethods(dispatcher)

    await runCommand(dispatcher, written, 'ctx-real-extension', 'context-callback-cmd', contextCallbackPath)
    await new Promise((resolve) => setTimeout(resolve, 20))

    const commitNotification = lastNotification(written, 'ui.commit')
    // T24: every `ui.commit` notification is now `{ windowLabel, commit }`
    // — see runner.ts's `PALETTE_WINDOW_LABEL` doc comment.
    const wrapped = commitNotification?.params as { windowLabel: string; commit: { kind: string; snapshot: { nodes: Record<string, { props: Record<string, unknown> }> } } }
    const callbackId = findCallbackId(wrapped.commit.snapshot, 'onAction')
    expect(callbackId, 'fixture must have registered an onAction callback in its committed tree').toBeTruthy()

    await dispatcher.feed(
      encodeFrame({ jsonrpc: '2.0', method: 'extension.invokeCallback', params: { callbackId, args: [] } } as unknown as never),
    )
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(capturedExtensionId).toBe('ctx-real-extension')

    await unmountCommand(dispatcher, written, 'ctx-real-extension', 'context-callback-cmd')
  })
})

describe('command context survives a deferred useEffect (T26 regression)', () => {
  let effectStoragePath: string
  let simplePath: string

  beforeAll(async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'openray-runner-effect-context-test-'))
    effectStoragePath = await bundleFixture('effect-storage-command', outDir)
    simplePath = await bundleFixture('simple-command', outDir)
  }, 30_000)

  it("a no-view command's useEffect sees its own mounting command's extensionId, not whichever command mounts next", async () => {
    let capturedExtensionId: unknown
    const decoder = new FrameDecoder()
    const written: Uint8Array[] = []
    const dispatcher = new RpcDispatcher((bytes) => {
      written.push(bytes)
      for (const message of decoder.push(bytes) as unknown as { id?: unknown; method?: string; params?: { extensionId?: unknown } }[]) {
        if (message.method === 'host.storage.set' && message.id !== undefined) {
          capturedExtensionId = message.params?.extensionId
          dispatcher.feed(encodeFrame({ jsonrpc: '2.0', id: message.id, result: null } as unknown as never))
        }
      }
    })
    registerRunnerMethods(dispatcher)

    // Mounts a second, unrelated command immediately after the first, then
    // flushes — a deliberately-adversarial ordering, though this
    // in-process harness (a synthetic dispatcher, not real stdio between
    // two OS processes) hasn't been observed to actually reproduce the
    // failure by itself; the real bug (three notes silently written under
    // extension id "unknown" — found live, T26) only showed up against the
    // genuine sidecar process's own I/O event-loop phases. This test
    // exists as a baseline correctness check for the fix (`getCommandContext`'s
    // `lastContextSlot` fallback in `command-context.ts`), not as
    // deterministic proof the race is reachable from this harness — it
    // passes both with and without that fallback here, verified directly.
    await runCommand(dispatcher, written, 'ctx-effect-extension', 'effect-storage-cmd', effectStoragePath)
    await runCommand(dispatcher, written, 'ctx-other-extension', 'simple-cmd', simplePath)
    await flushEffects()

    expect(capturedExtensionId).toBe('ctx-effect-extension')

    await unmountCommand(dispatcher, written, 'ctx-effect-extension', 'effect-storage-cmd')
    await unmountCommand(dispatcher, written, 'ctx-other-extension', 'simple-cmd')
  })
})

describe('extension-owned windows (T24)', () => {
  let windowCommandPath: string

  beforeAll(async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'openray-runner-window-test-'))
    windowCommandPath = await bundleFixture('window-command', outDir)
  }, 30_000)

  it('openExtensionWindow round-trips host.extensionWindow.open, waits for windowReady, then tags its commits with the window label', async () => {
    let capturedOpenOptions: unknown
    const decoder = new FrameDecoder()
    const written: Uint8Array[] = []
    const dispatcher = new RpcDispatcher((bytes) => {
      written.push(bytes)
      for (const message of decoder.push(bytes) as unknown as { id?: unknown; method?: string; params?: unknown }[]) {
        if (message.method === 'host.extensionWindow.open' && message.id !== undefined) {
          capturedOpenOptions = message.params
          // Mirrors `extension_window_open`'s real return shape: the
          // freshly generated window label as a bare JSON string.
          dispatcher.feed(encodeFrame({ jsonrpc: '2.0', id: message.id, result: 'ext-window-0' } as unknown as never))
        }
      }
    })
    registerRunnerMethods(dispatcher)

    await runCommand(dispatcher, written, 'ext-window', 'window-cmd', windowCommandPath)
    await flushEffects()

    // `WindowCommand` itself (the launched command, mounted into "main")
    // commits right away — `openExtensionWindow`'s own second mount is
    // what's blocked on `extension.windowReady`, so at this point the only
    // commit seen is "main"'s, not one tagged for the new window.
    expect((lastNotification(written, 'ui.commit')?.params as { windowLabel?: string } | undefined)?.windowLabel).toBe('main')
    expect(capturedOpenOptions).toEqual({ title: 'Fixture Window' })

    await dispatcher.feed(
      encodeFrame({ jsonrpc: '2.0', method: 'extension.windowReady', params: { windowLabel: 'ext-window-0' } } as unknown as never),
    )
    await flushEffects()

    const commitNotification = lastNotification(written, 'ui.commit')
    expect(commitNotification?.params).toMatchObject({ windowLabel: 'ext-window-0' })

    await unmountCommand(dispatcher, written, 'ext-window', 'window-cmd')
  })

  it('extension.windowClosed tears the window mount down without throwing on a second, duplicate close', async () => {
    const decoder = new FrameDecoder()
    const written: Uint8Array[] = []
    const dispatcher = new RpcDispatcher((bytes) => {
      written.push(bytes)
      for (const message of decoder.push(bytes) as unknown as { id?: unknown; method?: string }[]) {
        if (message.method === 'host.extensionWindow.open' && message.id !== undefined) {
          dispatcher.feed(encodeFrame({ jsonrpc: '2.0', id: message.id, result: 'ext-window-1' } as unknown as never))
        }
      }
    })
    registerRunnerMethods(dispatcher)

    await runCommand(dispatcher, written, 'ext-window', 'window-cmd', windowCommandPath)
    await flushEffects()
    await dispatcher.feed(
      encodeFrame({ jsonrpc: '2.0', method: 'extension.windowReady', params: { windowLabel: 'ext-window-1' } } as unknown as never),
    )
    await flushEffects()
    expect(lastNotification(written, 'ui.commit')).toBeDefined()

    // The native window was destroyed (user closed it) — must not throw,
    // and a second, duplicate report of the same close must not either
    // (mirrors `unmountCommand`'s own idempotency contract).
    await dispatcher.feed(
      encodeFrame({ jsonrpc: '2.0', method: 'extension.windowClosed', params: { windowLabel: 'ext-window-1' } } as unknown as never),
    )
    await expect(
      dispatcher.feed(encodeFrame({ jsonrpc: '2.0', method: 'extension.windowClosed', params: { windowLabel: 'ext-window-1' } } as unknown as never)),
    ).resolves.not.toThrow()

    await unmountCommand(dispatcher, written, 'ext-window', 'window-cmd')
  })
})

describe('MarkdownEditor node (T25)', () => {
  let markdownEditorPath: string

  beforeAll(async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'openray-runner-markdown-editor-test-'))
    markdownEditorPath = await bundleFixture('markdown-editor-command', outDir)
  }, 30_000)

  it('round-trips value/onChange through the reconciler like any other node', async () => {
    const { dispatcher, written } = makeDispatcher()
    registerRunnerMethods(dispatcher)

    await runCommand(dispatcher, written, 'ext-markdown', 'markdown-editor-cmd', markdownEditorPath)
    await flushEffects()

    const commitNotification = lastNotification(written, 'ui.commit')
    const wrapped = commitNotification?.params as {
      windowLabel: string
      commit: { kind: string; snapshot: { nodes: Record<string, { type: string; props: Record<string, unknown> }> } }
    }
    const node = Object.values(wrapped.commit.snapshot.nodes).find((n) => n.type === 'MarkdownEditor')
    expect(node, 'the fixture must have committed a MarkdownEditor node').toBeTruthy()
    expect(node?.props.id).toBe('doc-1')
    expect(node?.props.value).toBe('# Hello')

    const callbackId = findCallbackId(wrapped.commit.snapshot, 'onChange')
    expect(callbackId, 'onChange must have serialized as a callback marker').toBeTruthy()

    await dispatcher.feed(
      encodeFrame({ jsonrpc: '2.0', method: 'extension.invokeCallback', params: { callbackId, args: ['# Edited'] } } as unknown as never),
    )
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(events()).toContain('markdown-editor:onChange:# Edited')

    await unmountCommand(dispatcher, written, 'ext-markdown', 'markdown-editor-cmd')
  })
})
