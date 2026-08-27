import { useEffect } from 'react'
import { LocalStorage } from '@raycast/api'

/** T26 regression fixture: a no-view command whose `useEffect` calls an
 *  imperative API (`LocalStorage`, internally reading
 *  `getCommandContext().extensionId`) — proves the *deferred* effect
 *  still resolves the mounting command's real extension id, not the
 *  `"unknown"` fallback `AsyncLocalStorage.getStore()` alone would leave
 *  it at once `runCommand`'s own synchronous call chain has returned. */
export default function EffectStorageCommand() {
  useEffect(() => {
    void LocalStorage.setItem('marker', 'value')
  }, [])
  return null
}
