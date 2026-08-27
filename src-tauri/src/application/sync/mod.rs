//! Cloud Sync: syncs user data across machines through a user-chosen
//! folder (Dropbox/Drive/Syncthing/a network share), no server or
//! accounts. Payloads are passphrase-encrypted (see [`crypto`]) before
//! ever touching that folder.

pub mod crypto;
pub mod folder;
pub mod snapshot;

use std::fs;
use std::io;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

use crate::application::state::AppState;
use crate::error::Error;
use crate::infrastructure::db::SharedConnection;
use crate::infrastructure::settings::Settings;
use crate::infrastructure::time::now_millis as now_ms;
use crypto::Key32;
use snapshot::{ChangeSet, SettingsRecord, SyncToggles};

const DEVICE_ID_FILE: &str = "sync-device-id";
const KEY_CACHE_FILE: &str = "sync.key";
const POLL_INTERVAL: Duration = Duration::from_secs(30);

/// This machine's identity within the sync folder — one `devices/<id>.snap`
/// file per device (see the plan's Architecture). Generated once via
/// [`crate::infrastructure::time::pseudo_uuid`] (a one-off identifier,
/// not a per-table row id, so it doesn't use the `<kind>.<nanos>` row-id
/// convention) and persisted alongside `settings.json` so it survives
/// restarts but never syncs itself.
pub fn device_id(app: &AppHandle) -> io::Result<String> {
    let path = device_id_path(app)?;
    if let Ok(existing) = fs::read_to_string(&path) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }

    let id = crate::infrastructure::time::pseudo_uuid();
    fs::write(&path, &id)?;
    Ok(id)
}

fn device_id_path(app: &AppHandle) -> io::Result<PathBuf> {
    let config_dir = app.path().app_config_dir().map_err(io::Error::other)?;
    fs::create_dir_all(&config_dir)?;
    Ok(config_dir.join(DEVICE_ID_FILE))
}

fn key_cache_path(app: &AppHandle) -> io::Result<PathBuf> {
    let config_dir = app.path().app_config_dir().map_err(io::Error::other)?;
    fs::create_dir_all(&config_dir)?;
    Ok(config_dir.join(KEY_CACHE_FILE))
}

/// Caches the Argon2-derived key (never the passphrase) so the user enters
/// their passphrase once per machine, not on every launch. 0600 on unix;
/// no equivalent ACL tightening on macOS/Windows yet (see the plan's
/// Constraints — Windows/macOS credential-store hardening is a known gap).
fn save_key_cache(app: &AppHandle, key: &Key32) -> io::Result<()> {
    let path = key_cache_path(app)?;
    fs::write(&path, crypto::to_hex(key))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

fn load_key_cache(app: &AppHandle) -> io::Result<Option<Key32>> {
    let path = key_cache_path(app)?;
    match fs::read_to_string(&path) {
        Ok(hex) => {
            let bytes = crypto::from_hex(hex.trim()).ok_or_else(|| io::Error::other("corrupted key cache"))?;
            if bytes.len() != crypto::KEY_LEN {
                return Err(io::Error::other("corrupted key cache (wrong length)"));
            }
            let mut key = [0u8; crypto::KEY_LEN];
            key.copy_from_slice(&bytes);
            Ok(Some(key))
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// Expands `raw` and confirms it resolves to an absolute path, so a
/// relative `sync_folder` (which would resolve against whatever the
/// process's cwd happens to be at sync time — the exact bug that once
/// produced a literal `./~/tmp/openray-sync` directory before `expand_home`
/// was applied to `sync_folder` at all) is rejected up front rather than
/// silently writing encrypted data somewhere unexpected. `~` itself is
/// legitimate input; only a folder that's still relative *after*
/// expansion is rejected.
fn validate_sync_folder(raw: &str) -> Result<PathBuf, Error> {
    if raw.trim().is_empty() {
        return Err(Error::msg("set a sync folder before entering a passphrase"));
    }
    let folder = crate::infrastructure::paths::expand_home(raw);
    if !folder.is_absolute() {
        return Err(Error::msg(format!("folder: '{raw}' is not an absolute path")));
    }
    Ok(folder)
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "state", content = "message")]
pub enum SyncState {
    /// Sync is off, or on but not yet unlocked with a passphrase.
    Unconfigured,
    Syncing,
    Idle,
    Error(String),
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    #[serde(flatten)]
    pub state: SyncState,
    pub last_synced_at: Option<i64>,
    /// Device ids `snapshot::partition_by_version` excluded from the most
    /// recent merge for being more than one snapshot version away from
    /// this device's own — recomputed every cycle (a device that updates,
    /// or that stops writing to the folder, drops back out on its own).
    /// Sync otherwise proceeds normally with whatever devices *are*
    /// compatible; this is a heads-up, not a sync-blocking error.
    pub outdated_devices: Vec<String>,
}

/// Tracks whether `settings.json` has changed since the last export, so
/// the portable-settings record gets a real last-writer-wins timestamp
/// without needing `SettingsStore` itself to know anything about sync —
/// settings live in a JSON file, not a SQLite table, so they can't get a
/// trigger-maintained `sync_meta` row the way every other synced kind does.
/// `last_hash`/`last_updated_at` move together: a hash change stamps
/// `now_ms()` as the new timestamp; applying a remote settings record
/// (see [`SyncProvider::apply_portable_settings`]) sets both to the
/// remote's own hash/timestamp instead of "now", so this device doesn't
/// immediately re-report the just-applied settings as its own newer edit.
#[derive(Debug, Clone, Default)]
struct SettingsTracker {
    last_hash: Option<String>,
    last_updated_at: Option<i64>,
}

pub struct SyncProvider {
    app: AppHandle,
    conn: SharedConnection,
    status: Arc<Mutex<SyncStatus>>,
    key: Arc<Mutex<Option<Key32>>>,
    settings_tracker: Arc<Mutex<SettingsTracker>>,
    /// Serializes whole sync cycles. The worker loop and a
    /// user-triggered `sync_now` (Settings pane's "Sync Now", or the
    /// immediate sync after a successful `unlock_with_passphrase`) can
    /// otherwise overlap and race on the same device's temp-write path
    /// and on `sync_meta`/settings read-modify-write. A blocking lock
    /// (not `try_lock`-and-skip) is used deliberately: cycles are
    /// infrequent (30s apart) and cheap, so a caller waiting out a
    /// concurrent cycle rather than silently doing nothing is the
    /// correct trade-off for a user-initiated "Sync Now" click.
    cycle: Arc<Mutex<()>>,
}

impl SyncProvider {
    /// Constructs the provider and spawns its background worker thread —
    /// mirrors `ClipboardWatcher::start`'s pattern: the returned value and
    /// the thread's own copy share the same `Arc`-wrapped fields, so
    /// `AppState`'s copy (used by `api::sync`) and the worker stay in sync
    /// without needing `SyncProvider` itself behind an `Arc`.
    pub fn start(app: AppHandle, conn: SharedConnection) -> Self {
        let status = Arc::new(Mutex::new(SyncStatus { state: SyncState::Unconfigured, last_synced_at: None, outdated_devices: Vec::new() }));
        let key = Arc::new(Mutex::new(load_key_cache(&app).unwrap_or(None)));
        let settings_tracker = Arc::new(Mutex::new(SettingsTracker::default()));
        let cycle = Arc::new(Mutex::new(()));

        let provider = Self {
            app: app.clone(),
            conn: conn.clone(),
            status: Arc::clone(&status),
            key: Arc::clone(&key),
            settings_tracker: Arc::clone(&settings_tracker),
            cycle: Arc::clone(&cycle),
        };
        let worker = Self { app, conn, status, key, settings_tracker, cycle };

        thread::spawn(move || {
            // Run the first cycle immediately rather than waiting out a
            // full `POLL_INTERVAL` — otherwise a freshly configured
            // device sits at `Unconfigured`/stale for up to 30s after
            // launch for no reason.
            let _ = worker.sync_now();
            loop {
                thread::sleep(POLL_INTERVAL);
                let _ = worker.sync_now();
            }
        });

        provider
    }

    pub fn status(&self) -> SyncStatus {
        self.status.lock().unwrap().clone()
    }

    fn set_state(&self, state: SyncState) {
        let snapshot = {
            let mut status = self.status.lock().unwrap();
            status.state = state;
            status.clone()
        };
        let _ = self.app.emit("sync-status", &snapshot);
    }

    /// Records which remote devices `partition_by_version` excluded this
    /// cycle. Overwrites the previous list wholesale (not appended) so a
    /// device that has since updated, or gone quiet, disappears from the
    /// status on its own rather than needing to be explicitly cleared.
    fn set_outdated_devices(&self, devices: Vec<String>) {
        let snapshot = {
            let mut status = self.status.lock().unwrap();
            status.outdated_devices = devices;
            status.clone()
        };
        let _ = self.app.emit("sync-status", &snapshot);
    }

    fn mark_synced(&self) {
        let snapshot = {
            let mut status = self.status.lock().unwrap();
            status.state = SyncState::Idle;
            status.last_synced_at = Some(now_ms());
            status.clone()
        };
        let _ = self.app.emit("sync-status", &snapshot);
    }

    /// First device to call this for a given sync folder sets the
    /// passphrase (generates a salt, writes `meta.json`); every later
    /// device verifies its derived key against the stored keycheck. Caches
    /// the derived key to disk either way — never the passphrase itself.
    pub fn unlock_with_passphrase(&self, passphrase: &str) -> Result<(), Error> {
        let settings = self.current_settings()?;
        let folder = validate_sync_folder(&settings.sync_folder)?;

        let key = match folder::read_meta(&folder)? {
            Some(meta) => {
                let salt = crypto::from_hex(&meta.kdf_salt).ok_or_else(|| Error::msg("meta.json has a corrupted kdf_salt"))?;
                let key = crypto::derive_key(passphrase, &salt)?;
                let keycheck = crypto::from_hex(&meta.keycheck).ok_or_else(|| Error::msg("meta.json has a corrupted keycheck"))?;
                if !crypto::verify_keycheck(&key, &keycheck) {
                    return Err(Error::msg("wrong passphrase"));
                }
                key
            }
            None => {
                let salt = crypto::generate_salt()?;
                let key = crypto::derive_key(passphrase, &salt)?;
                let keycheck = crypto::seal_keycheck(&key)?;
                folder::write_meta(&folder, &folder::Meta { version: 1, kdf_salt: crypto::to_hex(&salt), keycheck: crypto::to_hex(&keycheck) })?;
                key
            }
        };

        save_key_cache(&self.app, &key)?;
        *self.key.lock().unwrap() = Some(key);
        // Sync immediately rather than leaving status at Unconfigured for
        // up to a full POLL_INTERVAL — the user just entered a correct
        // passphrase, so "still Unconfigured" would read as if it failed.
        self.sync_now()
    }

    fn current_settings(&self) -> Result<Settings, Error> {
        self.app.try_state::<AppState>().map(|s| s.settings.get()).ok_or_else(|| Error::msg("app state not managed"))
    }

    /// Runs one full sync cycle: export → push (snapshot + any new blobs)
    /// → pull remotes → merge → apply → GC blobs. Called by the worker on
    /// its poll interval and directly by `api::sync::sync_now` for the
    /// Settings pane's "Sync Now" button.
    pub fn sync_now(&self) -> Result<(), Error> {
        let _cycle_guard = self.cycle.lock().unwrap();
        let settings = self.current_settings()?;
        if !settings.sync_enabled || settings.sync_folder.trim().is_empty() {
            self.set_state(SyncState::Unconfigured);
            return Ok(());
        }
        let Some(key) = *self.key.lock().unwrap() else {
            self.set_state(SyncState::Unconfigured);
            return Ok(());
        };

        self.set_state(SyncState::Syncing);
        match self.sync_now_inner(&settings, &key) {
            Ok(()) => {
                self.mark_synced();
                Ok(())
            }
            Err(e) => {
                // `SyncState::Error` carries a `String` (it's serialized
                // straight to the frontend), not `Error` itself — `Error`
                // wraps types like `rusqlite::Error`/`io::Error` that
                // don't implement `Clone`, so the message is captured
                // here rather than cloning `e`.
                self.set_state(SyncState::Error(e.to_string()));
                Err(e)
            }
        }
    }

    fn sync_now_inner(&self, settings: &Settings, key: &Key32) -> Result<(), Error> {
        let folder = validate_sync_folder(&settings.sync_folder)?;
        let device_id = device_id(&self.app)?;
        let toggles = SyncToggles { core: settings.sync_core, extensions: settings.sync_extensions, clipboard: settings.sync_clipboard, usage: settings.sync_usage };

        let settings_json = serde_json::to_value(settings)?;
        let settings_updated_at = self.track_settings_change(&settings_json);

        let (local_snapshot, blobs) = {
            let conn = self.conn.lock().unwrap();
            snapshot::export(&conn, &device_id, toggles, &settings_json, settings_updated_at)?
        };

        folder::write_snapshot(&folder, &device_id, key, &local_snapshot)?;
        for blob in &blobs {
            folder::push_blob(&folder, key, blob)?;
        }

        let remotes = folder::read_snapshots(&folder, &device_id, key)?;
        let (usable_remotes, outdated_devices) = snapshot::partition_by_version(snapshot::SNAPSHOT_VERSION, remotes.clone());
        self.set_outdated_devices(outdated_devices);
        let changes = snapshot::merge(&local_snapshot, &usable_remotes);

        if !changes.records.is_empty() || changes.portable_settings.is_some() {
            {
                let mut conn = self.conn.lock().unwrap();
                snapshot::apply(&mut conn, &changes)?;
            }
            self.pull_missing_blobs(&folder, key, &changes)?;
            if let Some(settings_record) = &changes.portable_settings {
                self.apply_portable_settings(settings, settings_record)?;
            }
            self.refresh_root_providers_for(&changes);
            let _ = self.app.emit("sync-applied", ());
        }

        // GC keeps blobs referenced by every *present* snapshot file, not
        // just the version-compatible ones this cycle merged against — an
        // outdated device's own blobs must survive untouched until it
        // updates and rejoins, not get collected out from under it just
        // because this device isn't currently reading its records.
        let mut all_live = remotes;
        all_live.push(local_snapshot);
        let _ = folder::gc_blobs(&folder, &all_live);

        Ok(())
    }

    fn track_settings_change(&self, settings_json: &Value) -> Option<i64> {
        let hash = format!("{:x}", Sha256::digest(settings_json.to_string().as_bytes()));
        let mut tracker = self.settings_tracker.lock().unwrap();
        if tracker.last_hash.as_deref() == Some(hash.as_str()) {
            return tracker.last_updated_at;
        }
        let now = now_ms();
        tracker.last_hash = Some(hash);
        tracker.last_updated_at = Some(now);
        Some(now)
    }

    /// Pulls the encrypted blob for every applied clipboard record that
    /// carries an image (`apply_record` in `snapshot.rs` deliberately
    /// leaves `image_path` NULL — it has no knowledge of the sync
    /// folder), decrypts it under the clipboard image directory, then
    /// points the row at the resulting local path.
    fn pull_missing_blobs(&self, folder: &std::path::Path, key: &Key32, changes: &ChangeSet) -> Result<(), Error> {
        let dest_dir = self.app.path().app_data_dir()?.join("clipboard-images");
        for record in &changes.records {
            if record.kind != "clipboard_history" || record.deleted {
                continue;
            }
            let Some(hash) = record.fields.get("imageContentHash").and_then(|v| v.as_str()) else { continue };
            let local_path = folder::pull_blob(folder, key, hash, &dest_dir)?;
            let conn = self.conn.lock().unwrap();
            conn.execute(
                "UPDATE clipboard_history SET image_path = ?1 WHERE id = ?2",
                rusqlite::params![local_path.to_string_lossy(), record.id],
            )?;
        }
        Ok(())
    }

    /// Merges a winning remote settings record into the current local
    /// `Settings` and writes it via `SettingsStore::update()` — the UI
    /// updates for free through the `settings-changed` event that already
    /// fires from there. Only the keys present in the remote record's
    /// (already-excluded-field) JSON are overlaid, so `EXCLUDED_SETTINGS_FIELDS`
    /// stay whatever this machine already had.
    fn apply_portable_settings(&self, current: &Settings, remote: &SettingsRecord) -> Result<(), Error> {
        let mut current_json = serde_json::to_value(current)?;
        if let (Some(current_obj), Some(remote_obj)) = (current_json.as_object_mut(), remote.fields.as_object()) {
            for (key, value) in remote_obj {
                current_obj.insert(key.clone(), value.clone());
            }
        }
        let merged: Settings = serde_json::from_value(current_json)?;

        let store_snapshot = self.app.try_state::<AppState>().ok_or_else(|| Error::msg("app state not managed"))?;
        store_snapshot.settings.update(merged.clone())?;

        // Re-baseline the tracker on the settings we just applied, so the
        // very next tick doesn't see "content changed" (vs. what was
        // tracked before this apply) and re-report it as a fresh local
        // edit stamped with now() — that would fight the remote's own
        // timestamp on a future round instead of just agreeing with it.
        let merged_json = serde_json::to_value(&merged)?;
        let hash = format!("{:x}", Sha256::digest(merged_json.to_string().as_bytes()));
        let mut tracker = self.settings_tracker.lock().unwrap();
        tracker.last_hash = Some(hash);
        tracker.last_updated_at = Some(remote.updated_at);

        Ok(())
    }

    /// T32: a `root-provider` extension's listing is requested once at
    /// host startup and otherwise only ever re-requested by a targeted
    /// native-side trigger (`launch_root_provider_listing` — see
    /// `api::settings::update_settings`'s own T29 fix for the settings-
    /// change case) or the extension calling `refreshRootCommands()`
    /// itself. Cloud Sync applying a remote's `extension_storage` changes
    /// is a third such trigger nothing previously re-fired: found live
    /// (two real devices, T32) — a quicklink created on device A and
    /// synced to device B was correctly present in the extension's own
    /// storage and search view, but device B's *root search* kept
    /// showing "No results" for it until the app restarted, since nothing
    /// ever asked the quicklinks root-provider to re-list. Scoped to
    /// exactly the extensions whose `extension_storage` rows this sync
    /// cycle actually touched — not a blanket refresh of every
    /// root-provider on every sync tick — and only extensions that
    /// currently have a registered listing at all (`host_command_name`
    /// returns `None` for one that doesn't contribute root rows).
    fn refresh_root_providers_for(&self, changes: &ChangeSet) {
        let Some(state) = self.app.try_state::<AppState>() else { return };

        for extension_id in extension_ids_touched(changes) {
            let Some(command_name) = state.root_commands.host_command_name(&extension_id) else { continue };
            let app = self.app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = crate::application::extension_commands::launch_root_provider_listing(&app, &extension_id, &command_name).await {
                    log::warn!("failed to refresh '{extension_id}' root-provider listing after sync applied its data: {e}");
                }
            });
        }
    }
}

/// The distinct, sorted extension ids whose `extension_storage` rows a
/// merge changed — pulled out of `refresh_root_providers_for` so its
/// actual logic (which ids, deduped) is unit-testable without a mock
/// `AppHandle`/`AppState`.
fn extension_ids_touched(changes: &ChangeSet) -> Vec<String> {
    let mut extension_ids: Vec<String> = changes
        .records
        .iter()
        .filter(|r| r.kind == "extension_storage")
        .filter_map(|r| r.id.split_once(':').map(|(extension_id, _)| extension_id.to_string()))
        .collect();
    extension_ids.sort();
    extension_ids.dedup();
    extension_ids
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_folder_is_rejected() {
        let err = validate_sync_folder("").unwrap_err();
        assert!(err.to_string().contains("set a sync folder"));
        let err = validate_sync_folder("   ").unwrap_err();
        assert!(err.to_string().contains("set a sync folder"));
    }

    #[test]
    fn a_relative_folder_is_rejected_with_the_folder_error_convention() {
        let err = validate_sync_folder("relative/path").unwrap_err();
        assert!(err.to_string().starts_with("folder:"), "got: {err}");
    }

    #[test]
    fn an_absolute_folder_is_accepted() {
        let folder = validate_sync_folder("/tmp/openray-sync-test").unwrap();
        assert!(folder.is_absolute());
        assert_eq!(folder, PathBuf::from("/tmp/openray-sync-test"));
    }

    #[test]
    fn a_tilde_folder_expands_to_an_absolute_path_when_home_is_set() {
        if std::env::var_os("HOME").is_none() {
            return;
        }
        let folder = validate_sync_folder("~/openray-sync-test").unwrap();
        assert!(folder.is_absolute());
    }

    fn record(kind: &str, id: &str) -> snapshot::Record {
        snapshot::Record { kind: kind.to_string(), id: id.to_string(), updated_at: 0, deleted: false, fields: serde_json::Value::Null }
    }

    #[test]
    fn extension_ids_touched_extracts_the_prefix_before_the_colon_deduped_and_sorted() {
        let changes = ChangeSet {
            records: vec![
                record("extension_storage", "quicklinks:abc"),
                record("extension_storage", "quicklinks:def"),
                record("extension_storage", "notes:note:xyz"),
            ],
            portable_settings: None,
        };

        assert_eq!(extension_ids_touched(&changes), vec!["notes".to_string(), "quicklinks".to_string()]);
    }

    #[test]
    fn extension_ids_touched_ignores_non_extension_storage_kinds() {
        let changes = ChangeSet { records: vec![record("command_settings", "cmd.a"), record("usage", "cmd.b")], portable_settings: None };

        assert!(extension_ids_touched(&changes).is_empty());
    }
}
