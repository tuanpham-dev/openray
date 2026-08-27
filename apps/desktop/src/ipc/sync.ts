import { invoke } from '@tauri-apps/api/core'

export type SyncState = 'unconfigured' | 'syncing' | 'idle' | 'error'

export interface SyncStatus {
  state: SyncState
  /** Only present when state is 'error'. */
  message?: string
  lastSyncedAt: number | null
  /** Device ids skipped this cycle for being more than one snapshot
   *  version away from this device's own — those devices need an app
   *  update before their data will sync again. Sync otherwise proceeds
   *  normally with whatever devices are compatible. */
  outdatedDevices: string[]
}

export function getSyncStatus(): Promise<SyncStatus> {
  return invoke('get_sync_status')
}

/** Runs one sync cycle immediately — the worker already does this every
 *  30s on its own; this just doesn't make the user wait for the next tick. */
export function syncNow(): Promise<void> {
  return invoke('sync_now')
}

/** Unlocks (or, for the first device to use a given sync folder, sets)
 *  the sync passphrase and immediately runs a sync cycle. */
export function syncSetPassphrase(passphrase: string): Promise<void> {
  return invoke('sync_set_passphrase', { passphrase })
}
