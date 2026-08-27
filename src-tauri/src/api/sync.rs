use tauri::State;

use crate::application::state::AppState;
use crate::application::sync::SyncStatus;

#[tauri::command]
pub fn get_sync_status(state: State<AppState>) -> SyncStatus {
    state.sync.status()
}

/// Runs one sync cycle immediately — the Settings pane's "Sync Now"
/// button. The worker thread already does this every 30s on its own; this
/// just doesn't make the user wait for the next tick.
#[tauri::command]
pub fn sync_now(state: State<AppState>) -> Result<(), String> {
    Ok(state.sync.sync_now()?)
}

/// Unlocks (or, for the first device to use a given sync folder, sets)
/// the sync passphrase and immediately runs a sync cycle. The passphrase
/// itself is never returned, logged, or persisted — see
/// `SyncProvider::unlock_with_passphrase`.
#[tauri::command]
pub fn sync_set_passphrase(state: State<AppState>, passphrase: String) -> Result<(), String> {
    Ok(state.sync.unlock_with_passphrase(&passphrase)?)
}
