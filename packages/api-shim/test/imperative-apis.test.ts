import { createElement } from 'react'
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { setHostBridge, _resetHostBridgeForTests, type HostBridge } from '../src/bridge'
import { setCommandContext, _resetCommandContextForTests } from '../src/api/command-context'
import { Clipboard } from '../src/api/clipboard'
import { showToast, Toast } from '../src/api/toast'
import { invokeCallback, mount, _resetNodeIdsForTests } from '../src/reconciler'
import { LocalStorage } from '../src/api/storage'
import { getPreferenceValues } from '../src/api/preferences'
import { environment } from '../src/api/environment'
import { platform, capabilities } from '../src/api/platform'
import { open, closeMainWindow, showHUD, confirmAlert, getApplications } from '../src/api/system'
import { Action, ActionPanel } from '../src/components/ActionPanel'
import { refreshRootCommands } from '../src/api/root-commands'
import { AI, OAuth, UnsupportedError } from '../src/api/unsupported'
import { flush } from './flush'

function mockBridge(): { bridge: HostBridge; calls: { method: string; params: unknown }[] } {
  const calls: { method: string; params: unknown }[] = []
  const bridge: HostBridge = {
    call: vi.fn(async (method: string, params?: unknown) => {
      calls.push({ method, params })
      if (method === 'host.clipboard.read') return { text: 'clipboard contents' }
      if (method === 'host.toast.show') return 'toast-123'
      if (method === 'host.storage.get') return 'stored-value'
      if (method === 'host.storage.all') return { a: 1, b: 'two' }
      if (method === 'host.system.getApplications') return [{ name: 'Firefox', path: '/usr/bin/firefox' }]
      if (method === 'host.system.confirmAlert') return true
      return null
    }),
  }
  return { bridge, calls }
}

beforeEach(() => {
  _resetHostBridgeForTests()
  _resetCommandContextForTests()
  _resetNodeIdsForTests()
})

describe('Clipboard (mock RPC transport)', () => {
  it('routes copy/paste/read/readText/clear through the bridge', async () => {
    const { bridge, calls } = mockBridge()
    setHostBridge(bridge)

    await Clipboard.copy('hello')
    await Clipboard.paste('world')
    const text = await Clipboard.readText()
    await Clipboard.clear()

    expect(calls.map((c) => c.method)).toEqual([
      'host.clipboard.copy',
      'host.clipboard.paste',
      'host.clipboard.read',
      'host.clipboard.clear',
    ])
    expect(text).toBe('clipboard contents')
  })

  it('throws a clear error when no bridge is configured', async () => {
    await expect(Clipboard.copy('x')).rejects.toThrow(/No host bridge configured/)
  })
})

describe('Toast actions', () => {
  it('sends actions as callback ids and invokes the handler behind them', async () => {
    const { bridge, calls } = mockBridge()
    setHostBridge(bridge)
    const onAction = vi.fn()

    await showToast({ title: 'Saved', primaryAction: { title: 'Undo', onAction } })

    const params = calls[0]?.params as { primaryAction?: { title: string; callbackId?: string } }
    expect(params.primaryAction?.title).toBe('Undo')
    // The handler stays in this process; only its id crosses the bridge.
    expect(params.primaryAction?.callbackId).toBeTruthy()

    invokeCallback(params.primaryAction!.callbackId!, [])
    expect(onAction).toHaveBeenCalledOnce()
  })

  it('omits a callback id for an action with no handler', async () => {
    const { bridge, calls } = mockBridge()
    setHostBridge(bridge)

    await showToast({ title: 'FYI', primaryAction: { title: 'OK' } })

    const params = calls[0]?.params as { primaryAction?: { callbackId?: string } }
    expect(params.primaryAction?.callbackId).toBeUndefined()
  })

  it('releases action handlers when the toast is hidden', async () => {
    const { bridge, calls } = mockBridge()
    setHostBridge(bridge)

    const toast = await showToast({ title: 'Working', primaryAction: { title: 'Cancel', onAction: vi.fn() } })
    const params = calls[0]?.params as { primaryAction?: { callbackId?: string } }
    const callbackId = params.primaryAction!.callbackId!

    await toast.hide()
    // Left registered, these would accumulate for the life of the process.
    expect(() => invokeCallback(callbackId, [])).toThrow()
  })
})

describe('Toast (mock RPC transport)', () => {
  it('supports the options-object call signature', async () => {
    const { bridge, calls } = mockBridge()
    setHostBridge(bridge)

    const toast = await showToast({ style: Toast.Style.Success, title: 'Done' })
    expect(toast.title).toBe('Done')
    expect(calls[0]).toMatchObject({ method: 'host.toast.show', params: { style: 'SUCCESS', title: 'Done' } })
  })

  it('supports the legacy positional call signature', async () => {
    const { bridge, calls } = mockBridge()
    setHostBridge(bridge)

    await showToast(Toast.Style.Failure, 'Oops', 'details')
    expect(calls[0]).toMatchObject({ method: 'host.toast.show', params: { style: 'FAILURE', title: 'Oops', message: 'details' } })
  })

  it('hide() is a no-op until show() has assigned an id', async () => {
    const { bridge, calls } = mockBridge()
    setHostBridge(bridge)
    const toast = new Toast({ title: 'Hi' })
    await toast.hide()
    expect(calls).toHaveLength(0)
    await toast.show()
    await toast.hide()
    expect(calls.map((c) => c.method)).toEqual(['host.toast.show', 'host.toast.hide'])
  })
})

describe('LocalStorage (mock RPC transport, namespaced by extension)', () => {
  it('includes the current extensionId from command context in every call', async () => {
    const { bridge, calls } = mockBridge()
    setHostBridge(bridge)
    setCommandContext({
      extensionId: 'demo-ext',
      commandName: 'index',
      preferences: {},
      raycastVersion: '1.0.0',
      assetsPath: '',
      supportPath: '',
      isDevelopment: true,
      theme: 'light',
      platform: { os: 'linux', displayServer: 'x11' },
      capabilities: { selectionRead: true, dropAtCursor: true, multiFormatClipboard: true, menuBarIntrospection: true, windowControl: true },
    })

    const value = await LocalStorage.getItem('key1')
    await LocalStorage.setItem('key1', 'value1')
    const all = await LocalStorage.allItems()

    expect(value).toBe('stored-value')
    expect(all).toEqual({ a: 1, b: 'two' })
    for (const call of calls) {
      expect((call.params as { extensionId: string }).extensionId).toBe('demo-ext')
    }
  })
})

describe('getPreferenceValues / environment (synchronous, from command context)', () => {
  it('reads whatever setCommandContext last configured, no bridge required', () => {
    setCommandContext({
      extensionId: 'demo-ext',
      commandName: 'search',
      preferences: { apiToken: 'secret' },
      raycastVersion: '1.2.3',
      assetsPath: '/assets',
      supportPath: '/support',
      isDevelopment: false,
      theme: 'dark',
      platform: { os: 'linux', displayServer: 'x11' },
      capabilities: { selectionRead: true, dropAtCursor: true, multiFormatClipboard: true, menuBarIntrospection: true, windowControl: true },
    })

    expect(getPreferenceValues()).toEqual({ apiToken: 'secret' })
    expect(environment.raycastVersion).toBe('1.2.3')
    expect(environment.extensionName).toBe('demo-ext')
    expect(environment.appearance).toBe('dark')
    // The exact bug this regression-tests: a stub value used in a template
    // literal throws on ToPrimitive coercion (found in the T20 spike
    // against a real extension). A real string must survive this.
    expect(() => `Raycast/${environment.raycastVersion}`).not.toThrow()

    expect(platform.os).toBe('linux')
    expect(platform.displayServer).toBe('x11')
    expect(capabilities.selectionRead).toBe(true)
    expect(capabilities.windowControl).toBe(true)
  })

  it('falls back to every capability false when no context was ever set', () => {
    _resetCommandContextForTests()
    expect(capabilities.selectionRead).toBe(false)
    expect(capabilities.dropAtCursor).toBe(false)
    expect(capabilities.multiFormatClipboard).toBe(false)
    expect(capabilities.menuBarIntrospection).toBe(false)
    expect(capabilities.windowControl).toBe(false)
    expect(platform.os).toBe('linux')
    expect(platform.displayServer).toBeNull()
  })
})

describe('system APIs (mock RPC transport)', () => {
  it('open/closeMainWindow/showHUD/confirmAlert/getApplications round-trip through the bridge', async () => {
    const { bridge, calls } = mockBridge()
    setHostBridge(bridge)

    await open('https://example.com')
    await closeMainWindow()
    await showHUD('Copied!')
    const confirmed = await confirmAlert({ title: 'Sure?' })
    const apps = await getApplications()

    expect(confirmed).toBe(true)
    expect(apps).toEqual([{ name: 'Firefox', path: '/usr/bin/firefox' }])
    expect(calls.map((c) => c.method)).toEqual([
      'host.system.open',
      'host.system.closeMainWindow',
      'host.system.showHUD',
      'host.system.confirmAlert',
      'host.system.getApplications',
    ])
  })
})

describe('AI / OAuth (typed UnsupportedError, no bridge needed to fail)', () => {
  it('AI.ask throws UnsupportedError and shows a toast (best-effort)', async () => {
    const { bridge } = mockBridge()
    setHostBridge(bridge)
    await expect(AI.ask()).rejects.toThrow(UnsupportedError)
  })

  it('new OAuth.PKCEClient() throws synchronously', () => {
    expect(() => new OAuth.PKCEClient()).toThrow(UnsupportedError)
  })
})

/** Mounts a single element, waits for its first commit, and returns that
 * committed `Action` node's `onAction` callback marker — mirrors
 * `components.test.ts`'s `nodesByType`-based pattern for extracting a
 * real callback id rather than assuming one. */
async function mountAndGetActionCallback(element: ReturnType<typeof createElement>): Promise<string> {
  let snapshot: Record<string, { type: string; props: Record<string, unknown> }> | undefined
  mount(element, (commit) => {
    if (commit.kind === 'snapshot') snapshot = commit.snapshot.nodes
  })
  await flush()
  const node = Object.values(snapshot ?? {}).find((n) => n.type === 'Action')
  const marker = node?.props.onAction as { __callback: string } | undefined
  if (!marker) throw new Error('no Action node with an onAction callback was committed')
  return marker.__callback
}

describe('Action.CopyToClipboard / Action.Paste (T13)', () => {
  it('CopyToClipboard copies via the bridge, shows a HUD, and fires onCopy', async () => {
    const { bridge, calls } = mockBridge()
    setHostBridge(bridge)
    const copied: string[] = []

    const callbackId = await mountAndGetActionCallback(
      createElement(ActionPanel, null, createElement(Action.CopyToClipboard, { content: '😀', onCopy: (c) => copied.push(c) })),
    )
    invokeCallback(callbackId, [])
    await flush()

    expect(calls.map((c) => c.method)).toContain('host.clipboard.copy')
    expect(calls.map((c) => c.method)).toContain('host.system.showHUD')
    expect(copied).toEqual(['😀'])
  })

  it('Paste pastes via the bridge and fires onPaste', async () => {
    const { bridge, calls } = mockBridge()
    setHostBridge(bridge)
    const pasted: string[] = []

    const callbackId = await mountAndGetActionCallback(
      createElement(ActionPanel, null, createElement(Action.Paste, { content: '😀', onPaste: (c) => pasted.push(c) })),
    )
    invokeCallback(callbackId, [])
    await flush()

    expect(calls.map((c) => c.method)).toContain('host.clipboard.paste')
    expect(pasted).toEqual(['😀'])
  })
})

describe('refreshRootCommands (T14)', () => {
  it('calls the bridge with the current command context extensionId', async () => {
    const { bridge, calls } = mockBridge()
    setHostBridge(bridge)
    setCommandContext({
      extensionId: 'quicklinks',
      commandName: 'create',
      preferences: {},
      raycastVersion: '1.0.0',
      assetsPath: '',
      supportPath: '',
      isDevelopment: true,
      theme: 'light',
      platform: { os: 'linux', displayServer: 'x11' },
      capabilities: { selectionRead: true, dropAtCursor: true, multiFormatClipboard: true, menuBarIntrospection: true, windowControl: true },
    })

    await refreshRootCommands()

    expect(calls).toEqual([{ method: 'host.system.refreshRootCommands', params: { extensionId: 'quicklinks' } }])
  })
})

describe('showFailureToast', () => {
  it('raises a failure toast carrying the error message', async () => {
    // As a stub this swallowed the error entirely — no toast, no log line.
    const { showFailureToast } = await import('../src/api/toast')
    const { bridge, calls } = mockBridge()
    setHostBridge(bridge)

    await showFailureToast(new Error('disk on fire'))

    const toast = calls.find((c) => c.method === 'host.toast.show')
    expect(toast?.params).toMatchObject({ style: 'FAILURE', title: 'Something went wrong', message: 'disk on fire' })
  })

  it('accepts a non-Error and an explicit title', async () => {
    const { showFailureToast } = await import('../src/api/toast')
    const { bridge, calls } = mockBridge()
    setHostBridge(bridge)

    await showFailureToast('plain string', { title: 'Export failed' })

    const toast = calls.find((c) => c.method === 'host.toast.show')
    expect(toast?.params).toMatchObject({ title: 'Export failed', message: 'plain string' })
  })
})
