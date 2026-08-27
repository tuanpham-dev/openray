import { getHostBridge } from '../bridge'
import { getCommandContext } from './command-context'

export type LocalStorageValue = string | number | boolean

async function getItem<T extends LocalStorageValue>(key: string): Promise<T | undefined> {
  const result = await getHostBridge().call('host.storage.get', { extensionId: getCommandContext().extensionId, key })
  return (result ?? undefined) as T | undefined
}

async function setItem(key: string, value: LocalStorageValue): Promise<void> {
  await getHostBridge().call('host.storage.set', { extensionId: getCommandContext().extensionId, key, value })
}

async function removeItem(key: string): Promise<void> {
  await getHostBridge().call('host.storage.remove', { extensionId: getCommandContext().extensionId, key })
}

async function allItems<T extends Record<string, LocalStorageValue>>(): Promise<T> {
  const result = await getHostBridge().call('host.storage.all', { extensionId: getCommandContext().extensionId })
  return (result ?? {}) as T
}

async function clear(): Promise<void> {
  await getHostBridge().call('host.storage.clear', { extensionId: getCommandContext().extensionId })
}

export const LocalStorage = { getItem, setItem, removeItem, allItems, clear }
