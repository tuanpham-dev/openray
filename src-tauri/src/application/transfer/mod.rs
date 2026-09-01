//! Import / Export: writes the user's data to a single, optionally
//! passphrase-encrypted file, and merges such a file back in on another
//! machine. Entirely user-driven — there is no background worker and no
//! shared folder; every operation here happens because someone clicked
//! Export or Import.
//!
//! This replaced a folder-based Cloud Sync feature. The export/merge/apply
//! engine ([`snapshot`]) and the encryption ([`crypto`]) are that
//! feature's, kept as-is because they're exactly what a file import/export
//! needs; the per-device snapshot folder, the 30-second worker, and the
//! cached derived key are gone. Cloud sync may come back later, at which
//! point this module's pieces are the ones it would build on again.

pub mod crypto;
pub mod file;
pub mod snapshot;

use std::path::Path;

use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

use crate::application::state::AppState;
use crate::error::Error;
use crate::infrastructure::db::SharedConnection;
use rusqlite::Connection;
use crate::infrastructure::settings::Settings;
use crate::infrastructure::time::now_millis as now_ms;
use file::{ExtensionPayload, Payload};
use snapshot::{ChangeSet, ExportToggles, ExtensionScope, SettingsRecord};
use tauri::Manager;

/// Files the retired Cloud Sync feature left in the config directory.
/// `sync.key` in particular held a cached Argon2-derived encryption key,
/// so it's cleaned up rather than left sitting on disk with nothing left
/// to use it.
const LEGACY_SYNC_FILES: &[&str] = &["sync-device-id", "sync.key"];

/// Best-effort removal of the retired Cloud Sync feature's leftovers, run
/// once at startup. Every failure is ignored on purpose: a missing file is
/// the normal case (any install that never enabled sync), and a file that
/// can't be removed is not a reason to fail app launch.
pub fn cleanup_legacy_sync_files(app: &AppHandle) {
    let Ok(dir) = crate::infrastructure::paths::config_dir(app) else { return };
    for name in LEGACY_SYNC_FILES {
        let _ = std::fs::remove_file(dir.join(name));
    }
}

/// What an export actually produced, for the Settings pane to report back.
/// A per-extension failure is carried rather than returned as an error:
/// one extension's broken hook must not cost the user the whole file.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSummary {
    pub extensions_exported: Vec<String>,
    /// `(extension id, message)` — surfaced verbatim in the pane.
    pub failures: Vec<(String, String)>,
}

/// What an import actually changed, for the Settings pane to report back.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub records_applied: usize,
    pub settings_applied: bool,
    pub extensions_imported: Vec<String>,
    /// Extensions whose payload the file carried but that aren't installed
    /// here. Reported rather than dropped silently — on a fresh machine
    /// this can be most of the file, and the user needs to know.
    pub skipped_extensions: Vec<String>,
    pub failures: Vec<(String, String)>,
}

/// Writes the categories `toggles` selects to `path`, encrypted when
/// `passphrase` is `Some`.
///
/// Clipboard export is text-only: entries backed by an image file are
/// dropped rather than carried as records whose image can never be
/// resolved on the importing machine. The export file format has no blob
/// side-channel at all, so this is the one place that filtering has to
/// happen.
pub async fn export_to_file(
    app: &AppHandle,
    conn: &SharedConnection,
    path: &Path,
    passphrase: Option<&str>,
    toggles: ExportToggles,
    include_password_preferences: bool,
) -> Result<ExportSummary, Error> {
    let settings_json = serde_json::to_value(current_settings(app)?)?;

    let mut snapshot = {
        let conn = conn.lock().unwrap();
        let mut snapshot = host_owned_snapshot(&conn, toggles.clone(), &settings_json)?;
        // Enforced here rather than by the pane simply not asking for
        // them: "the user declined to export their credentials" is a
        // guarantee that shouldn't depend on frontend behavior.
        if !include_password_preferences {
            let passwords = snapshot::password_preferences_in_scope(&conn, &toggles.extensions)?;
            snapshot::strip_password_preferences(&mut snapshot.records, &passwords);
        }
        snapshot
    };
    snapshot.records.retain(|record| !is_image_clipboard_record(record));

    // One call per extension, in turn. Concurrency would buy nothing —
    // they all share a single Node process — and would muddy which
    // extension a failure belongs to.
    let mut summary = ExportSummary::default();
    let mut extensions = std::collections::BTreeMap::new();
    for extension_id in declaring_extensions(app, &toggles.extensions) {
        match crate::application::extension_commands::call_extension_export(app, &extension_id).await {
            Ok(value) => {
                extensions.insert(
                    extension_id.clone(),
                    ExtensionPayload {
                        version: value.get("version").cloned().unwrap_or(Value::Null),
                        data: value.get("data").cloned().unwrap_or(Value::Null),
                    },
                );
                summary.extensions_exported.push(extension_id);
            }
            Err(e) => summary.failures.push((extension_id, e.to_string())),
        }
    }

    file::write_export(path, &Payload { snapshot, extensions }, passphrase)?;
    Ok(summary)
}

/// The installed, enabled extensions that declare Import/Export and fall
/// inside `scope`, sorted for a stable order in the file and the summary.
fn declaring_extensions(app: &AppHandle, scope: &ExtensionScope) -> Vec<String> {
    let Some(state) = app.try_state::<AppState>() else { return Vec::new() };
    let mut ids: Vec<String> = state
        .extensions
        .list()
        .into_iter()
        .filter(|e| e.enabled && e.export.is_some() && scope.includes(&e.id))
        .map(|e| e.id)
        .collect();
    ids.sort();
    ids
}

/// The host's own half of an export — everything the host owns and can
/// read straight out of SQLite, with no extension involvement. Split out
/// so it stays testable against a plain in-memory `Connection`; the
/// extension hooks are what need a live `AppHandle`.
fn host_owned_snapshot(conn: &Connection, toggles: ExportToggles, settings_json: &Value) -> Result<snapshot::Snapshot, Error> {
    Ok(snapshot::export(conn, "export", toggles, settings_json, Some(now_ms()))?)
}

/// A `clipboard_history` record whose content is an image file rather
/// than text. Both signals are checked because they answer slightly
/// different questions: `kind` is the row's own declared type, while
/// `imageContentHash` is present exactly when `export` found a readable
/// image file behind it.
fn is_image_clipboard_record(record: &snapshot::Record) -> bool {
    if record.kind != "clipboard_history" || record.deleted {
        return false;
    }
    record.fields.get("imageContentHash").is_some_and(|v| !v.is_null()) || record.fields.get("kind").and_then(Value::as_str) == Some("image")
}

/// Merges `path`'s contents into this machine's data, last-writer-wins
/// per record (usage counts combine by max) — importing an older export
/// never clobbers a newer local edit.
///
/// The file's portable settings, by contrast, are applied unconditionally
/// when present. Local settings carry no timestamp of their own, so
/// there's nothing to compare them against; "import brings the file's
/// settings" is the predictable rule, and machine-local fields
/// (`EXCLUDED_SETTINGS_FIELDS`) are untouched either way.
pub async fn import_from_file(app: &AppHandle, conn: &SharedConnection, path: &Path, passphrase: Option<&str>) -> Result<ImportSummary, Error> {
    let payload = file::read_export(path, passphrase)?;
    let extension_payloads = payload.extensions.clone();
    let settings = current_settings(app)?;
    let settings_json = serde_json::to_value(&settings)?;

    let changes = {
        let mut conn = conn.lock().unwrap();
        merge_and_apply(&mut conn, payload, &settings_json)?
    };

    let settings_applied = match &changes.portable_settings {
        Some(record) => {
            apply_portable_settings(app, &settings, record)?;
            true
        }
        None => false,
    };

    refresh_root_providers_for(app, &changes);

    // Extension payloads go back to their owners last, once the host's own
    // merge has landed — an extension writing through its own storage API
    // then sees a settled database rather than one mid-merge.
    let installed = installed_extension_ids(app);
    let mut extensions_imported = Vec::new();
    let mut skipped_extensions = Vec::new();
    let mut failures = Vec::new();
    for (extension_id, extension_payload) in extension_payloads {
        if !installed.contains(&extension_id) {
            skipped_extensions.push(extension_id);
            continue;
        }
        match crate::application::extension_commands::call_extension_import(
            app,
            &extension_id,
            extension_payload.version,
            extension_payload.data,
        )
        .await
        {
            Ok(()) => extensions_imported.push(extension_id),
            Err(e) => failures.push((extension_id, e.to_string())),
        }
    }

    Ok(ImportSummary {
        records_applied: changes.records.len(),
        settings_applied,
        extensions_imported,
        skipped_extensions,
        failures,
    })
}

/// Every installed extension id, whether or not it declares Import/Export
/// — a file's payload is delivered to an extension the user *has*, on the
/// grounds that they explicitly asked to import it. Only genuinely
/// absent extensions are skipped.
fn installed_extension_ids(app: &AppHandle) -> std::collections::BTreeSet<String> {
    app.try_state::<AppState>()
        .map(|state| state.extensions.list().into_iter().map(|e| e.id).collect())
        .unwrap_or_default()
}

/// The data half of [`import_from_file`]: merge the imported snapshot
/// against what this machine already has, write the result, and hand back
/// the change set so the caller can act on its settings record and the
/// extensions it touched. Split out for the same reason as
/// [`host_owned_snapshot`] — everything here is testable without an
/// `AppHandle`.
fn merge_and_apply(conn: &mut Connection, payload: Payload, settings_json: &Value) -> Result<ChangeSet, Error> {
    let all = ExportToggles { core: true, extensions: ExtensionScope::All, clipboard: true, usage: true };
    // The local snapshot is only a merge baseline (what this machine
    // already has), so it's exported with every category on regardless of
    // what the imported file contains — anything less would let the file
    // win against records that were simply not read.
    let local = snapshot::export(conn, "local", all, settings_json, Some(now_ms()))?;

    let changes = merge_for_import(&local, payload.snapshot);
    if !changes.records.is_empty() {
        snapshot::apply(conn, &changes)?;
    }
    Ok(changes)
}

/// Merges an imported snapshot against the local one, then forces the
/// file's portable settings through if it had any.
///
/// [`snapshot::merge`] compares settings by `updated_at` like any other
/// record, and the local baseline is stamped `now_ms()` at export — so
/// left alone, the local side would always win and an import would never
/// bring settings across. Overriding here (rather than teaching `merge`
/// about import) keeps the merge engine's single last-writer-wins rule
/// intact for everything else.
fn merge_for_import(local: &snapshot::Snapshot, imported: snapshot::Snapshot) -> ChangeSet {
    let imported_settings = imported.portable_settings.clone();
    let mut changes = snapshot::merge(local, std::slice::from_ref(&imported));
    changes.portable_settings = imported_settings;
    changes
}

fn current_settings(app: &AppHandle) -> Result<Settings, Error> {
    app.try_state::<AppState>().map(|s| s.settings.get()).ok_or_else(|| Error::msg("app state not managed"))
}

/// Overlays an imported settings record onto the current `Settings` and
/// writes it via `SettingsStore::update()` — the UI updates for free
/// through the `settings-changed` event that already fires from there.
/// Only keys present in the record's (already-excluded-field) JSON are
/// overlaid, so `EXCLUDED_SETTINGS_FIELDS` stay whatever this machine
/// already had.
fn apply_portable_settings(app: &AppHandle, current: &Settings, imported: &SettingsRecord) -> Result<(), Error> {
    let mut current_json = serde_json::to_value(current)?;
    if let (Some(current_obj), Some(imported_obj)) = (current_json.as_object_mut(), imported.fields.as_object()) {
        for (key, value) in imported_obj {
            current_obj.insert(key.clone(), value.clone());
        }
    }
    let merged: Settings = serde_json::from_value(current_json)?;

    let state = app.try_state::<AppState>().ok_or_else(|| Error::msg("app state not managed"))?;
    state.settings.update(merged)?;
    Ok(())
}

/// A `root-provider` extension's listing is requested once at host startup
/// and otherwise only re-requested by a targeted native-side trigger or by
/// the extension calling `refreshRootCommands()` itself. Importing data
/// into `extension_storage` is a third such trigger.
///
/// Found live under the old sync feature (two real devices): a quicklink
/// created on device A and synced to device B was correctly present in
/// the extension's own storage and search view, but device B's *root
/// search* kept showing "No results" for it until the app restarted,
/// since nothing ever asked the quicklinks root-provider to re-list. The
/// same gap applies verbatim to an import, so the same fix is kept.
/// Scoped to exactly the extensions whose `extension_storage` rows this
/// import actually touched, and only those that currently register a
/// listing at all (`host_command_name` returns `None` otherwise).
fn refresh_root_providers_for(app: &AppHandle, changes: &ChangeSet) {
    let Some(state) = app.try_state::<AppState>() else { return };

    for extension_id in extension_ids_touched(changes) {
        let Some(command_name) = state.root_commands.host_command_name(&extension_id) else { continue };
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = crate::application::extension_commands::launch_root_provider_listing(&app, &extension_id, &command_name).await {
                log::warn!("failed to refresh '{extension_id}' root-provider listing after an import applied its data: {e}");
            }
        });
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
    use serde_json::json;

    fn record(kind: &str, id: &str) -> snapshot::Record {
        snapshot::Record { kind: kind.to_string(), id: id.to_string(), updated_at: 0, deleted: false, fields: serde_json::Value::Null }
    }

    /// Mirrors `snapshot.rs`'s own test helper: full migration history, so
    /// the schema matches a real upgraded install rather than a
    /// hand-picked subset of tables.
    fn migrated_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        for sql in [
            include_str!("../../../migrations/0001_init.sql"),
            include_str!("../../../migrations/0002_quicklinks.sql"),
            include_str!("../../../migrations/0003_snippets.sql"),
            include_str!("../../../migrations/0004_clipboard.sql"),
            include_str!("../../../migrations/0005_extensions.sql"),
            include_str!("../../../migrations/0006_installed_extensions.sql"),
            include_str!("../../../migrations/0007_extension_preferences.sql"),
            include_str!("../../../migrations/0009_clipboard_images.sql"),
            include_str!("../../../migrations/0010_extension_storage.sql"),
            include_str!("../../../migrations/0011_window_commands.sql"),
            include_str!("../../../migrations/0008_command_settings.sql"),
            include_str!("../../../migrations/0014_translate.sql"),
            include_str!("../../../migrations/0015_notes.sql"),
            include_str!("../../../migrations/0018_sync.sql"),
            include_str!("../../../migrations/0021_quicklinks_to_extension_storage.sql"),
            include_str!("../../../migrations/0022_snippets_to_extension_storage.sql"),
            include_str!("../../../migrations/0023_window_commands_to_extension_storage.sql"),
            include_str!("../../../migrations/0024_translate_to_extension_storage.sql"),
            include_str!("../../../migrations/0025_notes_to_extension_storage.sql"),
            include_str!("../../../migrations/0026_exclude_secret_keys_from_extension_storage_sync.sql"),
            include_str!("../../../migrations/0027_retire_migrated_native_tables.sql"),
            include_str!("../../../migrations/0028_extension_icon.sql"),
            include_str!("../../../migrations/0031_extension_export.sql"),
        ] {
            conn.execute_batch(sql).unwrap();
        }
        conn
    }

    fn all() -> ExportToggles {
        ExportToggles { core: true, extensions: ExtensionScope::All, clipboard: true, usage: true }
    }

    /// Stands in for `export_to_file`'s host-owned half: build the
    /// snapshot, apply the same image filter, write the file. The
    /// extension hooks are the part that needs a live `AppHandle`, so
    /// they're exercised in the running app rather than here.
    fn write_export_from(
        conn: &Connection,
        path: &std::path::Path,
        passphrase: Option<&str>,
        toggles: ExportToggles,
        settings_json: &Value,
    ) -> Result<(), Error> {
        let mut snapshot = host_owned_snapshot(conn, toggles, settings_json)?;
        snapshot.records.retain(|record| !is_image_clipboard_record(record));
        file::write_export(path, &Payload { snapshot, extensions: std::collections::BTreeMap::new() }, passphrase)
    }

    fn tmp_file(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("openray-transfer-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(format!("{name}.json"))
    }

    /// The merge tests below deliberately use `command_settings` — a
    /// host-owned kind — rather than `extension_storage`. Extension data
    /// no longer travels through the snapshot at all (it comes from each
    /// extension's own `exportData` hook), so exercising last-writer-wins
    /// through it would be testing a path that no longer exists.
    fn alias(conn: &Connection, command_id: &str, alias: &str) {
        conn.execute(
            "INSERT INTO command_settings (command_id, alias, hotkey, enabled) VALUES (?1, ?2, NULL, 1)
             ON CONFLICT(command_id) DO UPDATE SET alias = ?2",
            rusqlite::params![command_id, alias],
        )
        .unwrap();
    }

    fn alias_count(conn: &Connection, command_id: &str) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM command_settings WHERE command_id = ?1", [command_id], |row| row.get(0)).unwrap()
    }

    #[test]
    fn a_full_export_import_round_trip_moves_data_to_another_machine() {
        let source = migrated_conn();
        alias(&source, "cmd.a", "from-the-source-machine");
        let path = tmp_file("roundtrip");
        write_export_from(&source, &path, Some("a passphrase"), all(), &json!({"theme": "dark"})).unwrap();

        let mut destination = migrated_conn();
        let payload = file::read_export(&path, Some("a passphrase")).unwrap();
        let changes = merge_and_apply(&mut destination, payload, &json!({"theme": "light"})).unwrap();

        assert_eq!(alias_count(&destination, "cmd.a"), 1, "the exported command setting must arrive");
        assert_eq!(changes.portable_settings.unwrap().fields["theme"], "dark", "the file's settings must be the ones applied");
    }

    #[test]
    fn importing_an_older_export_does_not_resurrect_something_deleted_since() {
        // The reason import merges rather than replaces: a stale backup
        // must not undo newer local edits.
        let source = migrated_conn();
        alias(&source, "cmd.a", "created");
        let path = tmp_file("stale-import");
        write_export_from(&source, &path, None, all(), &json!({})).unwrap();

        // The same machine deletes it after that export was taken.
        let mut local = migrated_conn();
        alias(&local, "cmd.a", "created");
        local.execute("DELETE FROM command_settings WHERE command_id = 'cmd.a'", []).unwrap();
        assert_eq!(alias_count(&local, "cmd.a"), 0);

        let payload = file::read_export(&path, None).unwrap();
        merge_and_apply(&mut local, payload, &json!({})).unwrap();

        assert_eq!(alias_count(&local, "cmd.a"), 0, "the newer local delete must win over the older export");
    }

    #[test]
    fn a_newer_export_still_wins_over_older_local_data() {
        // The other direction of the same rule — merge must not be a
        // one-way "local always wins", or import would do nothing.
        let mut local = migrated_conn();
        alias(&local, "cmd.a", "old-local-value");

        let source = migrated_conn();
        alias(&source, "cmd.a", "newer-exported-value");
        source
            .execute("UPDATE sync_meta SET updated_at = updated_at + 60000 WHERE kind = 'command_settings' AND id = 'cmd.a'", [])
            .unwrap();
        let path = tmp_file("newer-import");
        write_export_from(&source, &path, None, all(), &json!({})).unwrap();

        let payload = file::read_export(&path, None).unwrap();
        merge_and_apply(&mut local, payload, &json!({})).unwrap();

        let value: String =
            local.query_row("SELECT alias FROM command_settings WHERE command_id = 'cmd.a'", [], |row| row.get(0)).unwrap();
        assert_eq!(value, "newer-exported-value");
    }

    #[test]
    fn clipboard_export_carries_text_entries_but_never_image_entries() {
        let conn = migrated_conn();
        let image_path = std::env::temp_dir().join(format!("openray-transfer-test-clip-{}.png", std::process::id()));
        std::fs::write(&image_path, b"fake png bytes").unwrap();
        conn.execute("INSERT INTO clipboard_history (id, content_hash, kind, text_content, created_at) VALUES ('c1', 'h1', 'text', 'copied text', 1)", []).unwrap();
        conn.execute(
            "INSERT INTO clipboard_history (id, content_hash, kind, created_at, image_path) VALUES ('c2', 'h2', 'image', 2, ?1)",
            [image_path.to_string_lossy()],
        )
        .unwrap();

        let path = tmp_file("clipboard-text-only");
        write_export_from(&conn, &path, None, all(), &json!({})).unwrap();
        let exported = file::read_export(&path, None).unwrap().snapshot;

        let clipboard_ids: Vec<&str> = exported.records.iter().filter(|r| r.kind == "clipboard_history").map(|r| r.id.as_str()).collect();
        assert_eq!(clipboard_ids, vec!["c1"], "the text entry exports and the image entry does not");
    }

    #[test]
    fn an_unchecked_category_is_absent_from_the_file_entirely() {
        let conn = migrated_conn();
        preference(&conn, "quicklinks", "token", "abc");
        conn.execute("INSERT INTO command_settings (command_id, alias, hotkey, enabled) VALUES ('cmd.a', 'x', NULL, 1)", []).unwrap();

        let path = tmp_file("scoped-export");
        let extensions_only = ExportToggles { core: false, extensions: ExtensionScope::All, clipboard: false, usage: false };
        write_export_from(&conn, &path, None, extensions_only, &json!({"theme": "dark"})).unwrap();
        let exported = file::read_export(&path, None).unwrap().snapshot;

        assert!(exported.records.iter().any(|r| r.kind == "extension_preference_values"));
        assert!(!exported.records.iter().any(|r| r.kind == "command_settings"), "core was unchecked");
        assert!(exported.portable_settings.is_none(), "settings ride with core, which was unchecked");
    }

    fn preference(conn: &Connection, extension_id: &str, name: &str, value: &str) {
        conn.execute(
            "INSERT INTO extension_preference_values (extension_id, name, value) VALUES (?1, ?2, ?3)",
            rusqlite::params![extension_id, name, value],
        )
        .unwrap();
    }

    fn password_definition(conn: &Connection, extension_id: &str, name: &str) {
        conn.execute(
            "INSERT INTO extension_preference_definitions (extension_id, command_name, name, preference_type, required)
             VALUES (?1, '', ?2, 'password', 0)",
            rusqlite::params![extension_id, name],
        )
        .unwrap();
    }

    #[test]
    fn an_extension_outside_the_scope_contributes_no_preference_values() {
        let conn = migrated_conn();
        preference(&conn, "quicklinks", "token", "abc");
        preference(&conn, "notes", "token", "def");

        let path = tmp_file("scope-only");
        let only_quicklinks =
            ExportToggles { core: false, extensions: ExtensionScope::Only(["quicklinks".to_string()].into()), clipboard: false, usage: false };
        write_export_from(&conn, &path, None, only_quicklinks, &json!({})).unwrap();
        let exported = file::read_export(&path, None).unwrap().snapshot;

        let ids: Vec<&str> = exported.records.iter().filter(|r| r.kind == "extension_preference_values").map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["quicklinks:token"], "only the checked extension's preferences travel");
    }

    #[test]
    fn an_empty_extension_scope_exports_no_extension_rows_at_all() {
        let conn = migrated_conn();
        preference(&conn, "quicklinks", "token", "abc");

        let path = tmp_file("scope-empty");
        let none = ExportToggles { core: false, extensions: ExtensionScope::Only(Default::default()), clipboard: false, usage: false };
        write_export_from(&conn, &path, None, none, &json!({})).unwrap();
        let exported = file::read_export(&path, None).unwrap().snapshot;

        assert!(!exported.records.iter().any(|r| r.kind == "extension_preference_values"));
    }

    #[test]
    fn password_preferences_are_found_only_within_the_scope() {
        let conn = migrated_conn();
        password_definition(&conn, "quicklinks", "token");
        preference(&conn, "quicklinks", "token", "hunter2");
        password_definition(&conn, "notes", "token");
        preference(&conn, "notes", "token", "swordfish");

        let all_found = snapshot::password_preferences_in_scope(&conn, &ExtensionScope::All).unwrap();
        assert_eq!(all_found.len(), 2);

        let scoped =
            snapshot::password_preferences_in_scope(&conn, &ExtensionScope::Only(["notes".to_string()].into())).unwrap();
        assert_eq!(scoped.len(), 1);
        assert_eq!(scoped[0].extension_id, "notes");

        let none = snapshot::password_preferences_in_scope(&conn, &ExtensionScope::Only(Default::default())).unwrap();
        assert!(none.is_empty());
    }

    #[test]
    fn a_blank_password_preference_is_not_reported_as_a_credential() {
        let conn = migrated_conn();
        password_definition(&conn, "quicklinks", "token");
        preference(&conn, "quicklinks", "token", "");

        assert!(snapshot::password_preferences_in_scope(&conn, &ExtensionScope::All).unwrap().is_empty());
    }

    #[test]
    fn declining_to_include_credentials_strips_them_from_the_records() {
        let conn = migrated_conn();
        password_definition(&conn, "quicklinks", "token");
        preference(&conn, "quicklinks", "token", "hunter2");
        preference(&conn, "quicklinks", "theme", "dark");

        let mut snapshot = host_owned_snapshot(&conn, all(), &json!({})).unwrap();
        let passwords = snapshot::password_preferences_in_scope(&conn, &ExtensionScope::All).unwrap();
        snapshot::strip_password_preferences(&mut snapshot.records, &passwords);

        let ids: Vec<&str> = snapshot.records.iter().filter(|r| r.kind == "extension_preference_values").map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["quicklinks:theme"], "the credential is gone, the ordinary preference stays");
    }

    #[test]
    fn re_importing_the_same_file_changes_nothing_the_second_time() {
        let source = migrated_conn();
        alias(&source, "cmd.a", "stable");
        let path = tmp_file("idempotent");
        write_export_from(&source, &path, None, all(), &json!({})).unwrap();

        let mut destination = migrated_conn();
        let first = merge_and_apply(&mut destination, file::read_export(&path, None).unwrap(), &json!({})).unwrap();
        let second = merge_and_apply(&mut destination, file::read_export(&path, None).unwrap(), &json!({})).unwrap();

        assert_eq!(first.records.len(), 1);
        assert!(second.records.is_empty(), "a second import of the same file must be a no-op");
        assert_eq!(alias_count(&destination, "cmd.a"), 1);
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

    #[test]
    fn image_clipboard_records_are_recognized_by_either_signal() {
        let mut by_hash = record("clipboard_history", "c1");
        by_hash.fields = json!({"kind": "image", "imageContentHash": "abc"});
        assert!(is_image_clipboard_record(&by_hash));

        let mut by_kind = record("clipboard_history", "c2");
        by_kind.fields = json!({"kind": "image", "imageContentHash": Value::Null});
        assert!(is_image_clipboard_record(&by_kind));

        let mut text = record("clipboard_history", "c3");
        text.fields = json!({"kind": "text", "textContent": "hello", "imageContentHash": Value::Null});
        assert!(!is_image_clipboard_record(&text), "a text entry must survive a text-only clipboard export");

        let mut tombstone = record("clipboard_history", "c4");
        tombstone.deleted = true;
        tombstone.fields = Value::Null;
        assert!(!is_image_clipboard_record(&tombstone), "tombstones must still export, or deletions never propagate");
    }

    #[test]
    fn a_non_clipboard_record_is_never_filtered_as_an_image() {
        let mut snippet = record("extension_storage", "snippets:s1");
        snippet.fields = json!({"value": "\"kind\": \"image\""});
        assert!(!is_image_clipboard_record(&snippet));
    }

    #[test]
    fn merge_for_import_lets_the_files_settings_win_over_the_local_baseline() {
        // The local baseline is stamped now_ms() at export, so plain
        // last-writer-wins would always discard the imported file's
        // settings — merge_for_import is what stops that.
        let local = snapshot::Snapshot {
            version: snapshot::SNAPSHOT_VERSION,
            device_id: "local".into(),
            records: vec![],
            portable_settings: Some(SettingsRecord { updated_at: now_ms(), fields: json!({"theme": "dark"}) }),
        };
        let imported = snapshot::Snapshot {
            version: snapshot::SNAPSHOT_VERSION,
            device_id: "export".into(),
            records: vec![],
            portable_settings: Some(SettingsRecord { updated_at: 1000, fields: json!({"theme": "light"}) }),
        };

        let changes = merge_for_import(&local, imported);

        assert_eq!(changes.portable_settings.unwrap().fields["theme"], "light");
    }

    #[test]
    fn merge_for_import_carries_no_settings_when_the_file_has_none() {
        let local = snapshot::Snapshot {
            version: snapshot::SNAPSHOT_VERSION,
            device_id: "local".into(),
            records: vec![],
            portable_settings: Some(SettingsRecord { updated_at: now_ms(), fields: json!({"theme": "dark"}) }),
        };
        let imported =
            snapshot::Snapshot { version: snapshot::SNAPSHOT_VERSION, device_id: "export".into(), records: vec![], portable_settings: None };

        assert!(merge_for_import(&local, imported).portable_settings.is_none());
    }
}
