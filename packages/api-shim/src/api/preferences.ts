import { getCommandContext } from './command-context'

/**
 * Synchronous by design, matching the real @raycast/api — extensions read
 * preferences at module top level. The command driver (T22+) resolves
 * these via one RPC call before evaluating the command module and calls
 * `setCommandContext`; this just reads whatever's already there.
 */
export function getPreferenceValues<T extends Record<string, unknown> = Record<string, unknown>>(): T {
  return getCommandContext().preferences as T
}
