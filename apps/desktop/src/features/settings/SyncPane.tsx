import { useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { Toggle } from './Toggle'
import { updateSettings, type Settings } from '../../ipc/settings'
import { getSyncStatus, syncNow, syncSetPassphrase, type SyncStatus } from '../../ipc/sync'

interface SyncPaneProps {
  settings: Settings
  onChange: (settings: Settings) => void
}

function statusLabel(status: SyncStatus | null): string {
  if (!status) return 'Loading…'
  switch (status.state) {
    case 'unconfigured':
      return 'Not set up'
    case 'syncing':
      return 'Syncing…'
    case 'idle':
      return status.lastSyncedAt ? `Synced ${new Date(status.lastSyncedAt).toLocaleTimeString()}` : 'Idle'
    case 'error':
      return `Error: ${status.message ?? 'unknown error'}`
  }
}

export function SyncPane({ settings, onChange }: SyncPaneProps) {
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [passphrase, setPassphrase] = useState('')
  const [passphraseError, setPassphraseError] = useState<string | null>(null)
  const [unlocking, setUnlocking] = useState(false)

  const save = (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch }
    onChange(next)
    void updateSettings(next)
  }

  useEffect(() => {
    void getSyncStatus().then(setStatus)
    const unlisten = listen<SyncStatus>('sync-status', (event) => setStatus(event.payload))
    return () => {
      void unlisten.then((fn) => fn())
    }
  }, [])

  const handleUnlock = () => {
    const trimmed = passphrase.trim()
    if (!trimmed || unlocking) return
    setUnlocking(true)
    setPassphraseError(null)
    syncSetPassphrase(trimmed)
      .then(() => setPassphrase(''))
      .catch((err: unknown) => setPassphraseError(err instanceof Error ? err.message : String(err)))
      .finally(() => setUnlocking(false))
  }

  return (
    <div className="openray-settings-pane openray-settings-pane--form">
      <div className="openray-settings-form">
        <label className="openray-settings-form-label" htmlFor="sync-enabled-toggle">
          Cloud Sync
        </label>
        <span className="openray-settings-control-group">
          <Toggle id="sync-enabled-toggle" checked={settings.syncEnabled} onChange={(checked) => save({ syncEnabled: checked })} />
          <span className="openray-settings-control-hint">
            Syncs your data through a folder you choose (Dropbox, Google Drive, Syncthing, a network share) — no account, no server.
          </span>
        </span>

        <label className="openray-settings-form-label" htmlFor="sync-folder-input">
          Sync Folder
        </label>
        <input
          id="sync-folder-input"
          type="text"
          placeholder="/path/to/Dropbox"
          value={settings.syncFolder}
          onChange={(event) => save({ syncFolder: event.target.value })}
        />

        <hr className="openray-settings-separator" />

        <label className="openray-settings-form-label" htmlFor="sync-passphrase-input">
          Passphrase
        </label>
        <span className="openray-settings-control-group">
          <input
            id="sync-passphrase-input"
            type="password"
            placeholder="Enter passphrase"
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') handleUnlock()
            }}
          />
          <button type="button" className="openray-form-button" disabled={unlocking || !passphrase.trim()} onClick={handleUnlock}>
            {unlocking ? 'Unlocking…' : 'Unlock'}
          </button>
          <span className="openray-settings-control-hint">
            The first machine to sync a folder sets the passphrase; every other machine enters that same one. Never stored or
            sent anywhere — only used locally to derive an encryption key.
          </span>
        </span>
        {passphraseError && <span className="openray-hotkey-error">{passphraseError}</span>}

        <hr className="openray-settings-separator" />

        <label className="openray-settings-form-label" htmlFor="sync-core-toggle">
          Core Data
        </label>
        <span className="openray-settings-control-group">
          <Toggle id="sync-core-toggle" checked={settings.syncCore} onChange={(checked) => save({ syncCore: checked })} />
          <span className="openray-settings-control-hint">Notes, snippets, quicklinks, window presets, translate commands, aliases/hotkeys, and general settings</span>
        </span>

        <label className="openray-settings-form-label" htmlFor="sync-extensions-toggle">
          Extensions
        </label>
        <span className="openray-settings-control-group">
          <Toggle id="sync-extensions-toggle" checked={settings.syncExtensions} onChange={(checked) => save({ syncExtensions: checked })} />
          <span className="openray-settings-control-hint">Extension preferences and storage — can include API keys, always encrypted</span>
        </span>

        <label className="openray-settings-form-label" htmlFor="sync-clipboard-toggle">
          Clipboard History
        </label>
        <span className="openray-settings-control-group">
          <Toggle id="sync-clipboard-toggle" checked={settings.syncClipboard} onChange={(checked) => save({ syncClipboard: checked })} />
          <span className="openray-settings-control-hint">Clipboard history (including images) and translate history — off by default</span>
        </span>

        <label className="openray-settings-form-label" htmlFor="sync-usage-toggle">
          Usage Counts
        </label>
        <span className="openray-settings-control-group">
          <Toggle id="sync-usage-toggle" checked={settings.syncUsage} onChange={(checked) => save({ syncUsage: checked })} />
          <span className="openray-settings-control-hint">Command usage counts, combined across machines rather than overwritten</span>
        </span>

        <hr className="openray-settings-separator" />

        <span className="openray-settings-form-label">Status</span>
        <span className="openray-settings-control-group">
          <span className="openray-settings-control-hint">{statusLabel(status)}</span>
          <button type="button" className="openray-form-button" onClick={() => void syncNow()}>
            Sync Now
          </button>
        </span>
        {status && status.outdatedDevices.length > 0 && (
          <span className="openray-settings-control-group">
            <span className="openray-hotkey-error">
              {status.outdatedDevices.length === 1
                ? '1 device is on an older version and needs an app update before it syncs again.'
                : `${status.outdatedDevices.length} devices are on an older version and need an app update before they sync again.`}
            </span>
          </span>
        )}
      </div>
      <div className="openray-settings-bottom-spacer" />
    </div>
  )
}
