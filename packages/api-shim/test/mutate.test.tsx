import { createElement } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { _resetNodeIdsForTests, mount } from '../src/reconciler'
import { List } from '../src/components/List'
import { usePromise } from '../src/utils-hooks'

/**
 * The bug these cover: `mutate` applied an optimistic update and never
 * undid it. A failed write left the optimistic value on screen — a list
 * showing an item that was never created — with no error anywhere, which
 * is the exact failure an optimistic update is supposed to make safe.
 */

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(() => setImmediate(resolve)))
}

beforeEach(() => {
  _resetNodeIdsForTests()
})

async function renderHook<T>(use: () => T): Promise<{ current: T }> {
  const box = { current: undefined as unknown as T }
  function Probe() {
    box.current = use()
    return createElement(List, null)
  }
  mount(createElement(Probe), () => {})
  await flush()
  return box
}

describe('mutate', () => {
  it('applies an optimistic update immediately', async () => {
    const hook = await renderHook(() => usePromise(async () => 'server', []))
    await flush()

    void hook.current.mutate(new Promise((resolve) => setTimeout(() => resolve('written'), 20)), {
      optimisticUpdate: () => 'optimistic',
    })
    await flush()

    expect(hook.current.data).toBe('optimistic')
  })

  it('keeps the written value when the work succeeds', async () => {
    const hook = await renderHook(() => usePromise(async () => 'server', []))
    await flush()

    await hook.current.mutate(Promise.resolve('written'), {
      optimisticUpdate: () => 'optimistic',
      shouldRevalidateAfter: false,
    })
    await flush()

    expect(hook.current.data).toBe('written')
  })

  it('rolls back and rethrows when the work fails', async () => {
    const hook = await renderHook(() => usePromise(async () => 'server', []))
    await flush()
    expect(hook.current.data).toBe('server')

    await expect(
      hook.current.mutate(Promise.reject(new Error('write failed')), { optimisticUpdate: () => 'optimistic' }),
    ).rejects.toThrow('write failed')
    await flush()

    expect(hook.current.data).toBe('server')
  })

  it('honours rollbackOnError: false', async () => {
    const hook = await renderHook(() => usePromise(async () => 'server', []))
    await flush()

    await expect(
      hook.current.mutate(Promise.reject(new Error('nope')), {
        optimisticUpdate: () => 'optimistic',
        rollbackOnError: false,
      }),
    ).rejects.toThrow()
    await flush()

    expect(hook.current.data).toBe('optimistic')
  })
})
