import { useCallback } from 'react'
import { getHostBridge } from '../bridge'
import { usePromise, type UsePromiseOptions, type UsePromiseResult } from '../utils-hooks'

/**
 * One read-only `SELECT` against a SQLite file.
 *
 * Runs on the Rust side, which already has `rusqlite` — adding a second
 * SQLite stack to the Node host to avoid one bridge call would be the
 * worse trade. The connection is opened read-only and anything but a
 * `SELECT` is refused: not access control (an extension already has full
 * filesystem access through Node) but so a query cannot damage a database
 * the extension doesn't own.
 */
export async function executeSQL<T = unknown>(databasePath: string, query: string): Promise<T[]> {
  const rows = await getHostBridge().call('host.sql.query', { path: databasePath, query })
  return (rows ?? []) as T[]
}

export interface UseSQLOptions<T> {
  execute?: boolean
  permissionPriming?: string
  onData?: (data: T[]) => void
  onError?: (error: Error) => void
}

/** `executeSQL` as a data hook, on the same `usePromise` contract as every
 *  other one here. Raycast's own use case is a browser history database. */
export function useSQL<T = unknown>(
  databasePath: string,
  query: string,
  options?: UseSQLOptions<T>,
): UsePromiseResult<T[]> {
  const run = useCallback(() => executeSQL<T>(databasePath, query), [databasePath, query])

  const promiseOptions: UsePromiseOptions<T[]> = {}
  if (options?.execute !== undefined) promiseOptions.execute = options.execute
  if (options?.onData) promiseOptions.onData = options.onData
  if (options?.onError) promiseOptions.onError = options.onError
  return usePromise(run, [], promiseOptions)
}
