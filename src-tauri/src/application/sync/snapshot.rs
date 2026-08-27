//! Export/merge/apply for Cloud Sync: turns local DB rows into a
//! device-portable [`Snapshot`], merges snapshots from multiple devices by
//! last-writer-wins, and applies a merged result back into the local DB.
//!
//! Records are read from and written through `sync_meta` directly via SQL,
//! not through any feature's own application-layer API — this module is
//! Cloud Sync's own data-access layer over the same tables (native ones
//! still owned here, like `clipboard_history`/`command_settings`/`usage`,
//! and `extension_storage`/`extension_preference_values` on behalf of
//! every extension-owned feature), kept as free functions over
//! `&rusqlite::Connection` so it's unit-testable without a live
//! `AppHandle`.

use std::path::PathBuf;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// Bumped when a wave's shape change could actually break an old reader
/// — not every data-moving wave needs this. A wave that dual-writes a
/// migrated feature (keeping its previous native-table `kind` untouched
/// alongside a new `extension_storage` kind for the same data — see
/// T15/T16/T18's own migrations for the pattern) needs no bump at all:
/// an un-updated device only ever reads the untouched old kind, so
/// nothing about it looks different to a stale reader; `T15`/`T16`/`T18`
/// confirmed this in practice and left the constant alone. This only
/// matters for a wave that actually changes what a shared `kind` string
/// means to both old and new readers at once (T35's own motivating
/// scenario). [`partition_by_version`] is what makes that window safe
/// when it does happen: a device that hasn't updated yet still
/// exports/expects the previous version's shape, and this device's
/// merge only trusts a remote within one version of its own.
///
/// T31 bumps this 1 → 2: the wave that finally drops the six
/// `notes`/`snippets`/`quicklinks`/`window_commands`/`translate_commands`/
/// `translate_history` kinds every prior wave (T15/T16/T18/T22/T26)
/// deliberately deferred (migration `0027_retire_migrated_native_tables`).
/// This particular bump is lower-stakes than the doc comment above might
/// suggest: every row those six tables ever held was already copied into
/// `extension_storage` at each table's own migration time
/// (`0021`-`0025`), and no application code has written to any of them
/// since — so a still-on-version-1 remote's snapshot contains nothing
/// this device doesn't already have via the live `extension_storage`
/// kind. `apply_record`'s `other =>` fallback below already skips an
/// unrecognized kind gracefully (log + no-op), so an adjacent-version
/// remote still carrying one of the six retired kinds converges cleanly
/// — its now-unrecognized records are silently (and correctly) ignored,
/// not lost data. The bump exists to document the wire-format change
/// honestly, not because this particular removal is unsafe within the
/// existing one-version compatibility window.
pub const SNAPSHOT_VERSION: u32 = 2;

/// Which categories to include — mirrors the `sync_core`/`sync_extensions`/
/// `sync_clipboard`/`sync_usage` settings toggles.
#[derive(Debug, Clone, Copy)]
pub struct SyncToggles {
    pub core: bool,
    pub extensions: bool,
    pub clipboard: bool,
    pub usage: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snapshot {
    pub version: u32,
    pub device_id: String,
    pub records: Vec<Record>,
    /// `None` when `sync_core` is off, or on a device that has never
    /// changed its settings since enabling sync.
    pub portable_settings: Option<SettingsRecord>,
}

/// One row from a synced table (or a tombstone for a deleted one).
/// `fields` mirrors the table's own columns (excluding `id`) as a JSON
/// object, and is `Value::Null` when `deleted` — there's nothing left to
/// carry. `usage` is the one kind merged by max instead of by `updated_at`
/// — see [`merge`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Record {
    pub kind: String,
    pub id: String,
    pub updated_at: i64,
    pub deleted: bool,
    pub fields: Value,
}

/// `settings.json`'s portable subset, keyed the same way a table record
/// would be (kind `"settings"`, id `"portable"`) but carried separately
/// since it isn't a SQLite row — see [`crate::infrastructure::settings`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SettingsRecord {
    pub updated_at: i64,
    pub fields: Value,
}

/// One `clipboard_history` row's raw columns, in `SELECT` order —
/// (content_hash, kind, text_content, created_at, image_path, image_width,
/// image_height). Named here only to satisfy clippy's `type_complexity`
/// lint on the query in `export`; the tuple's own field order is what
/// actually matters, not this alias.
type ClipboardHistoryRow = (String, String, Option<String>, i64, Option<String>, Option<i64>, Option<i64>);

/// A clipboard image this device's snapshot references, for the folder
/// layer (`application::sync::folder`) to seal into `blobs/<hash>.bin`.
pub struct BlobRef {
    pub hash: String,
    pub path: PathBuf,
}

/// Settings fields that never sync: machine-local paths (`script_directories`,
/// `screenshot_search_scopes`), a per-machine OS integration
/// (`launch_at_login`), and the sync configuration itself (would otherwise
/// let one device silently flip sync on/off on every other device).
const EXCLUDED_SETTINGS_FIELDS: &[&str] = &[
    "scriptDirectories",
    "screenshotSearchScopes",
    "launchAtLogin",
    "syncEnabled",
    "syncFolder",
    "syncCore",
    "syncExtensions",
    "syncClipboard",
    "syncUsage",
];

/// Strips [`EXCLUDED_SETTINGS_FIELDS`] from a full `Settings` JSON object,
/// leaving only what's portable across machines.
pub fn portable_settings_fields(settings_json: &Value) -> Value {
    let mut fields = settings_json.clone();
    if let Some(obj) = fields.as_object_mut() {
        for key in EXCLUDED_SETTINGS_FIELDS {
            obj.remove(*key);
        }
    }
    fields
}

/// Reads every synced table's current rows plus tombstones (from
/// `sync_meta`) into a `Snapshot`. `settings_json` is the full current
/// `Settings` serialized to JSON by the caller (this module has no
/// `Settings` dependency of its own); `settings_updated_at` is `None`
/// when there's nothing to include yet (sync just enabled, no settings
/// change tracked).
///
/// T31 dropped the `notes`/`snippets`/`quicklinks`/`window_commands`/
/// `translate_commands`/`translate_history` kinds (and this function's
/// former `sync_id` lazy-backfill step for the first and last of those,
/// which no longer have a native table to backfill) — see
/// `SNAPSHOT_VERSION`'s doc comment and migration
/// `0027_retire_migrated_native_tables`.
pub fn export(
    conn: &Connection,
    device_id: &str,
    toggles: SyncToggles,
    settings_json: &Value,
    settings_updated_at: Option<i64>,
) -> rusqlite::Result<(Snapshot, Vec<BlobRef>)> {
    let mut records = Vec::new();
    let mut blobs = Vec::new();

    if toggles.core {
        records.extend(export_kind(conn, "command_settings", |c, id| {
            c.query_row("SELECT alias, hotkey, enabled FROM command_settings WHERE command_id = ?1", [id], |row| {
                Ok(json!({"alias": row.get::<_, Option<String>>(0)?, "hotkey": row.get::<_, Option<String>>(1)?, "enabled": row.get::<_, i64>(2)? != 0}))
            })
            .map(Some)
            .or_else(ok_none_if_no_rows)
        })?);
    }

    if toggles.extensions {
        records.extend(export_kind(conn, "extension_preference_values", |c, id| {
            let (extension_id, name) = split_composite_id(id);
            c.query_row(
                "SELECT value FROM extension_preference_values WHERE extension_id = ?1 AND name = ?2",
                params![extension_id, name],
                |row| Ok(json!({"extensionId": extension_id, "name": name, "value": row.get::<_, String>(0)?})),
            )
            .map(Some)
            .or_else(ok_none_if_no_rows)
        })?);
        records.extend(export_kind(conn, "extension_storage", |c, id| {
            let (extension_id, key) = split_composite_id(id);
            c.query_row("SELECT value FROM extension_storage WHERE extension_id = ?1 AND key = ?2", params![extension_id, key], |row| {
                Ok(json!({"extensionId": extension_id, "key": key, "value": row.get::<_, String>(0)?}))
            })
            .map(Some)
            .or_else(ok_none_if_no_rows)
        })?);
    }

    if toggles.clipboard {
        records.extend(export_kind(conn, "clipboard_history", |c, id| {
            let row: Option<ClipboardHistoryRow> = c
                .query_row(
                    "SELECT content_hash, kind, text_content, created_at, image_path, image_width, image_height FROM clipboard_history WHERE id = ?1",
                    [id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?)),
                )
                .map(Some)
                .or_else(ok_none_if_no_rows)?;
            let Some((content_hash, kind, text_content, created_at, image_path, image_width, image_height)) = row else {
                return Ok(None);
            };
            let image_content_hash = match &image_path {
                Some(path) => hash_file(path).ok(),
                None => None,
            };
            Ok(Some(json!({
                "contentHash": content_hash, "kind": kind, "textContent": text_content, "createdAt": created_at,
                "imageContentHash": image_content_hash, "imageWidth": image_width, "imageHeight": image_height,
            })))
        })?);
        // Second pass: collect blob refs alongside the records that carry
        // an image, since the record itself only stores the hash.
        for record in records.iter().filter(|r| r.kind == "clipboard_history" && !r.deleted) {
            if let Some(hash) = record.fields.get("imageContentHash").and_then(Value::as_str) {
                let path: Option<String> = conn
                    .query_row("SELECT image_path FROM clipboard_history WHERE id = ?1", [&record.id], |row| row.get(0))
                    .ok()
                    .flatten();
                if let Some(path) = path {
                    blobs.push(BlobRef { hash: hash.to_string(), path: PathBuf::from(path) });
                }
            }
        }
    }

    if toggles.usage {
        records.extend(export_kind(conn, "usage", |c, id| {
            c.query_row("SELECT hits, last_used_at FROM usage WHERE command_id = ?1", [id], |row| {
                Ok(json!({"hits": row.get::<_, i64>(0)?, "lastUsedAt": row.get::<_, i64>(1)?}))
            })
            .map(Some)
            .or_else(ok_none_if_no_rows)
        })?);
    }

    let portable_settings = if toggles.core {
        settings_updated_at.map(|updated_at| SettingsRecord { updated_at, fields: portable_settings_fields(settings_json) })
    } else {
        None
    };

    Ok((Snapshot { version: SNAPSHOT_VERSION, device_id: device_id.to_string(), records, portable_settings }, blobs))
}

/// Splits `remotes` into ones the local device should merge against (its
/// own [`SNAPSHOT_VERSION`], or the version immediately before or after
/// it) and ones too far apart to trust — either a remote lagging two or
/// more waves behind, or this device itself being the one that's stale.
/// The latter group's device ids come back separately so the caller can
/// surface "device X needs an update" instead of silently dropping that
/// device's data with no explanation. One version of slack in *either*
/// direction (not just "remote is older") is what lets two devices
/// upgrade one at a time regardless of which one happens to update first.
pub fn partition_by_version(local_version: u32, remotes: Vec<Snapshot>) -> (Vec<Snapshot>, Vec<String>) {
    let mut usable = Vec::new();
    let mut outdated = Vec::new();
    for remote in remotes {
        if local_version.abs_diff(remote.version) <= 1 {
            usable.push(remote);
        } else {
            outdated.push(remote.device_id.clone());
        }
    }
    (usable, outdated)
}

fn ok_none_if_no_rows<T>(err: rusqlite::Error) -> rusqlite::Result<Option<T>> {
    match err {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(other),
    }
}

fn split_composite_id(id: &str) -> (&str, &str) {
    id.split_once(':').unwrap_or((id, ""))
}

fn hash_file(path: &str) -> std::io::Result<String> {
    let bytes = std::fs::read(path)?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(format!("{:x}", hasher.finalize()))
}

fn export_kind(
    conn: &Connection,
    kind: &str,
    fields_for_id: impl Fn(&Connection, &str) -> rusqlite::Result<Option<Value>>,
) -> rusqlite::Result<Vec<Record>> {
    let mut stmt = conn.prepare("SELECT id, updated_at, deleted FROM sync_meta WHERE kind = ?1")?;
    let rows: Vec<(String, i64, bool)> =
        stmt.query_map([kind], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)? != 0)))?.collect::<Result<_, _>>()?;

    let mut records = Vec::with_capacity(rows.len());
    for (id, updated_at, deleted) in rows {
        let fields = if deleted { Value::Null } else { fields_for_id(conn, &id)?.unwrap_or(Value::Null) };
        // A row whose sync_meta entry exists but whose live row is gone
        // (raced with a delete between the two queries) is exported as a
        // no-op with fields=Null; the next export cycle will see the
        // AFTER DELETE trigger's tombstone instead. Skip it rather than
        // asserting deleted=true on stale information.
        if !deleted && fields.is_null() {
            continue;
        }
        records.push(Record { kind: kind.to_string(), id, updated_at, deleted, fields });
    }
    Ok(records)
}

/// The result of merging this device's local snapshot against one or more
/// remote snapshots — what [`apply`] should write.
#[derive(Debug, Clone, Default)]
pub struct ChangeSet {
    pub records: Vec<Record>,
    pub portable_settings: Option<SettingsRecord>,
}

/// Merges `local` against every snapshot in `remotes`, last-writer-wins on
/// `updated_at` with `device_id` as the tiebreak for exact ties, except
/// `kind == "usage"` which merges by `max(hits)`/`max(lastUsedAt)` instead
/// — two devices both using a command should combine their counts, not
/// have one overwrite the other. Returns only the records that changed
/// relative to `local` (i.e. what a remote contributed or improved on);
/// `apply` only needs to write those.
pub fn merge(local: &Snapshot, remotes: &[Snapshot]) -> ChangeSet {
    let mut winners: std::collections::HashMap<(String, String), (Record, String)> =
        local.records.iter().map(|r| ((r.kind.clone(), r.id.clone()), (r.clone(), local.device_id.clone()))).collect();

    for remote in remotes {
        for candidate in &remote.records {
            let key = (candidate.kind.clone(), candidate.id.clone());
            match winners.get(&key) {
                None => {
                    winners.insert(key, (candidate.clone(), remote.device_id.clone()));
                }
                Some((current, current_device)) => {
                    if candidate.kind == "usage" {
                        let merged = merge_usage(current, candidate);
                        winners.insert(key, (merged, current_device.clone()));
                        continue;
                    }
                    let candidate_wins = candidate.updated_at > current.updated_at
                        || (candidate.updated_at == current.updated_at && remote.device_id > *current_device);
                    if candidate_wins {
                        winners.insert(key, (candidate.clone(), remote.device_id.clone()));
                    }
                }
            }
        }
    }

    let records = winners
        .into_values()
        .map(|(record, _)| record)
        .filter(|record| {
            // Compare the actual outcome, not just updated_at: an exact-tie
            // winner picked by device_id can share local's timestamp while
            // still carrying different fields (a different device's
            // content), and that still needs to be written by apply().
            local
                .records
                .iter()
                .find(|r| r.kind == record.kind && r.id == record.id)
                .map(|local_record| local_record.fields != record.fields || local_record.deleted != record.deleted)
                .unwrap_or(true)
        })
        .collect();

    let portable_settings = match (&local.portable_settings, remotes.iter().filter_map(|r| r.portable_settings.as_ref()).max_by_key(|r| r.updated_at)) {
        (_, None) => None,
        (None, Some(remote)) => Some(remote.clone()),
        (Some(local_settings), Some(remote)) if remote.updated_at > local_settings.updated_at => Some(remote.clone()),
        _ => None,
    };

    ChangeSet { records, portable_settings }
}

fn merge_usage(a: &Record, b: &Record) -> Record {
    let a_hits = a.fields.get("hits").and_then(Value::as_i64).unwrap_or(0);
    let b_hits = b.fields.get("hits").and_then(Value::as_i64).unwrap_or(0);
    let a_last = a.fields.get("lastUsedAt").and_then(Value::as_i64).unwrap_or(0);
    let b_last = b.fields.get("lastUsedAt").and_then(Value::as_i64).unwrap_or(0);
    Record {
        kind: a.kind.clone(),
        id: a.id.clone(),
        updated_at: a.updated_at.max(b.updated_at),
        deleted: false,
        fields: json!({"hits": a_hits.max(b_hits), "lastUsedAt": a_last.max(b_last)}),
    }
}

/// Writes a merged [`ChangeSet`] into the local DB in one transaction.
/// Each record's `sync_meta` entry is overwritten with the merged
/// timestamp directly (not left for the table's own trigger to re-derive
/// from "now") so an applied-but-otherwise-unchanged record doesn't look
/// locally modified on the very next export.
pub fn apply(conn: &mut Connection, changes: &ChangeSet) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    for record in &changes.records {
        apply_record(&tx, record)?;
        tx.execute(
            "INSERT INTO sync_meta (kind, id, updated_at, deleted) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(kind, id) DO UPDATE SET updated_at = excluded.updated_at, deleted = excluded.deleted",
            params![record.kind, record.id, record.updated_at, record.deleted as i64],
        )?;
    }
    tx.commit()
}

fn apply_record(conn: &Connection, record: &Record) -> rusqlite::Result<()> {
    let f = &record.fields;
    match record.kind.as_str() {
        "command_settings" => {
            if record.deleted {
                conn.execute("DELETE FROM command_settings WHERE command_id = ?1", [&record.id])?;
            } else {
                conn.execute(
                    "INSERT INTO command_settings (command_id, alias, hotkey, enabled) VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT(command_id) DO UPDATE SET alias = excluded.alias, hotkey = excluded.hotkey, enabled = excluded.enabled",
                    params![record.id, f["alias"].as_str(), f["hotkey"].as_str(), f["enabled"].as_bool().unwrap_or(true) as i64],
                )?;
            }
        }
        "clipboard_history" => {
            if record.deleted {
                conn.execute("DELETE FROM clipboard_history WHERE id = ?1", [&record.id])?;
            } else {
                // image_path is deliberately left NULL here — the folder
                // layer (application::sync::folder) fills it in with a
                // local path after decrypting the referenced blob, since
                // this function has no knowledge of the sync folder.
                conn.execute(
                    "INSERT INTO clipboard_history (id, content_hash, kind, text_content, created_at, image_width, image_height) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                     ON CONFLICT(id) DO NOTHING",
                    params![
                        record.id,
                        f["contentHash"].as_str().unwrap_or(""),
                        f["kind"].as_str().unwrap_or("text"),
                        f["textContent"].as_str(),
                        f["createdAt"].as_i64().unwrap_or(0),
                        f["imageWidth"].as_i64(),
                        f["imageHeight"].as_i64()
                    ],
                )?;
            }
        }
        "extension_preference_values" => {
            let (extension_id, name) = split_composite_id(&record.id);
            if record.deleted {
                conn.execute("DELETE FROM extension_preference_values WHERE extension_id = ?1 AND name = ?2", params![extension_id, name])?;
            } else {
                conn.execute(
                    "INSERT INTO extension_preference_values (extension_id, name, value) VALUES (?1, ?2, ?3)
                     ON CONFLICT(extension_id, name) DO UPDATE SET value = excluded.value",
                    params![extension_id, name, f["value"].as_str().unwrap_or("")],
                )?;
            }
        }
        "extension_storage" => {
            let (extension_id, key) = split_composite_id(&record.id);
            if record.deleted {
                conn.execute("DELETE FROM extension_storage WHERE extension_id = ?1 AND key = ?2", params![extension_id, key])?;
            } else {
                conn.execute(
                    "INSERT INTO extension_storage (extension_id, key, value) VALUES (?1, ?2, ?3)
                     ON CONFLICT(extension_id, key) DO UPDATE SET value = excluded.value",
                    params![extension_id, key, f["value"].as_str().unwrap_or("")],
                )?;
            }
        }
        "usage" => {
            conn.execute(
                "INSERT INTO usage (command_id, hits, last_used_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(command_id) DO UPDATE SET hits = excluded.hits, last_used_at = excluded.last_used_at",
                params![record.id, f["hits"].as_i64().unwrap_or(0), f["lastUsedAt"].as_i64().unwrap_or(0)],
            )?;
        }
        other => {
            log::warn!("sync: apply_record got an unknown kind '{other}', skipping");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Full history through 0027, not just the tables `export`/
    /// `apply_record` still read/write post-T31 — 0018_sync.sql's own SQL
    /// (`ALTER TABLE notes ADD COLUMN sync_id`, its `notes`/
    /// `translate_history` triggers) has a hard dependency on
    /// `notes`/`translate_history` already existing (0015/0014), so this
    /// helper can't skip straight to the tables that remain live; it
    /// mirrors true head state by running everything in order and letting
    /// 0027 drop the six retired tables at the end, same as a real
    /// upgrading install.
    fn migrated_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../../../migrations/0001_init.sql")).unwrap();
        conn.execute_batch(include_str!("../../../migrations/0002_quicklinks.sql")).unwrap();
        conn.execute_batch(include_str!("../../../migrations/0003_snippets.sql")).unwrap();
        conn.execute_batch(include_str!("../../../migrations/0004_clipboard.sql")).unwrap();
        conn.execute_batch(include_str!("../../../migrations/0007_extension_preferences.sql")).unwrap();
        conn.execute_batch(include_str!("../../../migrations/0009_clipboard_images.sql")).unwrap();
        conn.execute_batch(include_str!("../../../migrations/0010_extension_storage.sql")).unwrap();
        conn.execute_batch(include_str!("../../../migrations/0011_window_commands.sql")).unwrap();
        conn.execute_batch(include_str!("../../../migrations/0008_command_settings.sql")).unwrap();
        conn.execute_batch(include_str!("../../../migrations/0014_translate.sql")).unwrap();
        conn.execute_batch(include_str!("../../../migrations/0015_notes.sql")).unwrap();
        conn.execute_batch(include_str!("../../../migrations/0018_sync.sql")).unwrap();
        conn.execute_batch(include_str!("../../../migrations/0021_quicklinks_to_extension_storage.sql")).unwrap();
        conn.execute_batch(include_str!("../../../migrations/0022_snippets_to_extension_storage.sql")).unwrap();
        conn.execute_batch(include_str!("../../../migrations/0023_window_commands_to_extension_storage.sql")).unwrap();
        conn.execute_batch(include_str!("../../../migrations/0024_translate_to_extension_storage.sql")).unwrap();
        conn.execute_batch(include_str!("../../../migrations/0025_notes_to_extension_storage.sql")).unwrap();
        conn.execute_batch(include_str!("../../../migrations/0026_exclude_secret_keys_from_extension_storage_sync.sql")).unwrap();
        conn.execute_batch(include_str!("../../../migrations/0027_retire_migrated_native_tables.sql")).unwrap();
        conn
    }

    fn all_toggles() -> SyncToggles {
        SyncToggles { core: true, extensions: true, clipboard: true, usage: true }
    }

    #[test]
    fn export_includes_an_extension_storage_value_and_a_command_setting() {
        let conn = migrated_conn();
        conn.execute("INSERT INTO extension_storage (extension_id, key, value) VALUES ('quicklinks', 'quicklink.1', '\"best regards\"')", []).unwrap();
        conn.execute("INSERT INTO command_settings (command_id, alias, hotkey, enabled) VALUES ('cmd.a', NULL, NULL, 1)", []).unwrap();

        let (snapshot, _) = export(&conn, "device-a", all_toggles(), &json!({}), None).unwrap();

        assert!(snapshot.records.iter().any(|r| r.kind == "extension_storage" && r.id == "quicklinks:quicklink.1" && r.fields["value"] == "\"best regards\""));
        assert!(snapshot.records.iter().any(|r| r.kind == "command_settings" && r.id == "cmd.a"));
    }

    #[test]
    fn export_marks_a_deleted_extension_storage_value_as_a_tombstone_with_null_fields() {
        let conn = migrated_conn();
        conn.execute("INSERT INTO extension_storage (extension_id, key, value) VALUES ('quicklinks', 'quicklink.1', '\"body\"')", []).unwrap();
        conn.execute("DELETE FROM extension_storage WHERE extension_id = 'quicklinks' AND key = 'quicklink.1'", []).unwrap();

        let (snapshot, _) = export(&conn, "device-a", all_toggles(), &json!({}), None).unwrap();

        let record = snapshot.records.iter().find(|r| r.kind == "extension_storage" && r.id == "quicklinks:quicklink.1").unwrap();
        assert!(record.deleted);
        assert!(record.fields.is_null());
    }

    #[test]
    fn merge_prefers_the_newer_updated_at_across_devices() {
        let local = Snapshot {
            version: SNAPSHOT_VERSION,
            device_id: "a".into(),
            records: vec![Record { kind: "extension_storage".into(), id: "quicklinks:s1".into(), updated_at: 1000, deleted: false, fields: json!({"value": "old"}) }],
            portable_settings: None,
        };
        let remote = Snapshot {
            version: SNAPSHOT_VERSION,
            device_id: "b".into(),
            records: vec![Record { kind: "extension_storage".into(), id: "quicklinks:s1".into(), updated_at: 2000, deleted: false, fields: json!({"value": "new"}) }],
            portable_settings: None,
        };

        let changes = merge(&local, &[remote]);

        let record = changes.records.iter().find(|r| r.id == "quicklinks:s1").unwrap();
        assert_eq!(record.fields["value"], "new");
    }

    #[test]
    fn merge_keeps_the_local_record_when_it_is_newer() {
        let local = Snapshot {
            version: SNAPSHOT_VERSION,
            device_id: "a".into(),
            records: vec![Record { kind: "extension_storage".into(), id: "quicklinks:s1".into(), updated_at: 5000, deleted: false, fields: json!({"value": "keep me"}) }],
            portable_settings: None,
        };
        let remote = Snapshot {
            version: SNAPSHOT_VERSION,
            device_id: "b".into(),
            records: vec![Record { kind: "extension_storage".into(), id: "quicklinks:s1".into(), updated_at: 1000, deleted: false, fields: json!({"value": "stale"}) }],
            portable_settings: None,
        };

        let changes = merge(&local, &[remote]);

        assert!(changes.records.is_empty(), "local is newer, so nothing needs to be written back");
    }

    #[test]
    fn merge_breaks_exact_ties_by_device_id() {
        let local = Snapshot {
            version: SNAPSHOT_VERSION,
            device_id: "aaa".into(),
            records: vec![Record { kind: "extension_storage".into(), id: "quicklinks:s1".into(), updated_at: 1000, deleted: false, fields: json!({"value": "from aaa"}) }],
            portable_settings: None,
        };
        let remote = Snapshot {
            version: SNAPSHOT_VERSION,
            device_id: "zzz".into(),
            records: vec![Record { kind: "extension_storage".into(), id: "quicklinks:s1".into(), updated_at: 1000, deleted: false, fields: json!({"value": "from zzz"}) }],
            portable_settings: None,
        };

        let changes = merge(&local, &[remote]);

        let record = changes.records.iter().find(|r| r.id == "quicklinks:s1").unwrap();
        assert_eq!(record.fields["value"], "from zzz", "higher device_id wins an exact-timestamp tie");
    }

    #[test]
    fn merge_takes_the_max_of_each_side_for_usage_instead_of_last_writer_wins() {
        // local has the higher hit count but the older lastUsedAt; remote
        // has the opposite. Max-per-field means neither value should be
        // dropped just because its record "lost" — see the plan's
        // "usage merges by max(hits), max(last_used_at)" decision.
        let local = Snapshot {
            version: SNAPSHOT_VERSION,
            device_id: "a".into(),
            records: vec![Record { kind: "usage".into(), id: "cmd.a".into(), updated_at: 1000, deleted: false, fields: json!({"hits": 10, "lastUsedAt": 500}) }],
            portable_settings: None,
        };
        let remote = Snapshot {
            version: SNAPSHOT_VERSION,
            device_id: "b".into(),
            records: vec![Record { kind: "usage".into(), id: "cmd.a".into(), updated_at: 2000, deleted: false, fields: json!({"hits": 3, "lastUsedAt": 900}) }],
            portable_settings: None,
        };

        let changes = merge(&local, &[remote]);

        let record = changes.records.iter().find(|r| r.id == "cmd.a").unwrap();
        assert_eq!(record.fields["hits"], 10, "local's higher hit count must survive the merge");
        assert_eq!(record.fields["lastUsedAt"], 900, "remote's more recent lastUsedAt must survive the merge");
    }

    #[test]
    fn apply_writes_a_new_extension_storage_value_from_a_remote_record() {
        let mut conn = migrated_conn();
        let changes = ChangeSet {
            records: vec![Record {
                kind: "extension_storage".into(),
                id: "quicklinks:s1".into(),
                updated_at: 1000,
                deleted: false,
                fields: json!({"extensionId": "quicklinks", "key": "s1", "value": "\"hello\""}),
            }],
            portable_settings: None,
        };

        apply(&mut conn, &changes).unwrap();

        let value: String = conn.query_row("SELECT value FROM extension_storage WHERE extension_id = 'quicklinks' AND key = 's1'", [], |row| row.get(0)).unwrap();
        assert_eq!(value, "\"hello\"");
        let sync_meta_updated_at: i64 =
            conn.query_row("SELECT updated_at FROM sync_meta WHERE kind = 'extension_storage' AND id = 'quicklinks:s1'", [], |row| row.get(0)).unwrap();
        assert_eq!(sync_meta_updated_at, 1000);
    }

    #[test]
    fn apply_deletes_an_extension_storage_value_marked_as_a_tombstone() {
        let mut conn = migrated_conn();
        conn.execute("INSERT INTO extension_storage (extension_id, key, value) VALUES ('quicklinks', 's1', '\"body\"')", []).unwrap();
        let changes =
            ChangeSet { records: vec![Record { kind: "extension_storage".into(), id: "quicklinks:s1".into(), updated_at: 2000, deleted: true, fields: Value::Null }], portable_settings: None };

        apply(&mut conn, &changes).unwrap();

        let count: i64 = conn.query_row("SELECT COUNT(*) FROM extension_storage WHERE extension_id = 'quicklinks' AND key = 's1'", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 0);
    }

    /// A snapshot still carrying a kind this device no longer recognizes
    /// (a remote on the pre-T31 wire format, still exporting the retired
    /// `notes`/`snippets`/etc. kinds — see `SNAPSHOT_VERSION`'s doc
    /// comment) must apply cleanly with no error, not panic or corrupt
    /// state — `apply_record`'s `other =>` fallback just skips it.
    #[test]
    fn apply_of_an_unrecognized_retired_kind_is_a_graceful_no_op() {
        let mut conn = migrated_conn();
        let changes = ChangeSet {
            records: vec![Record { kind: "notes".into(), id: "some-old-sync-id".into(), updated_at: 1000, deleted: false, fields: json!({"content": "from a pre-T31 device"}) }],
            portable_settings: None,
        };

        apply(&mut conn, &changes).unwrap();

        let sync_meta_updated_at: i64 = conn.query_row("SELECT updated_at FROM sync_meta WHERE kind = 'notes' AND id = 'some-old-sync-id'", [], |row| row.get(0)).unwrap();
        assert_eq!(sync_meta_updated_at, 1000, "sync_meta still records the tombstone/timestamp bookkeeping even though the row itself had nowhere to go");
    }

    #[test]
    fn portable_settings_fields_strips_machine_local_and_sync_config_keys() {
        let full = json!({
            "hotkey": "Alt+Space", "theme": "dark", "scriptDirectories": ["/home/x"],
            "screenshotSearchScopes": ["~/Pictures"], "launchAtLogin": true,
            "syncEnabled": true, "syncFolder": "/mnt/dropbox", "syncCore": true,
            "syncExtensions": true, "syncClipboard": false, "syncUsage": true,
        });

        let portable = portable_settings_fields(&full);

        assert_eq!(portable["hotkey"], "Alt+Space");
        assert_eq!(portable["theme"], "dark");
        for key in EXCLUDED_SETTINGS_FIELDS {
            assert!(portable.get(*key).is_none(), "{key} should have been stripped");
        }
    }

    /// End-to-end through export → merge → apply across two independent
    /// DBs, standing in for two machines exchanging snapshots directly
    /// (skipping the folder/encryption layer, which is T6/T7's job) — a
    /// create on A must appear on B, and a delete on B must tombstone the
    /// row on A, in a single round of "each pulls the other's export".
    #[test]
    fn two_devices_converge_through_export_merge_apply() {
        let mut conn_a = migrated_conn();
        let mut conn_b = migrated_conn();

        conn_a.execute("INSERT INTO extension_storage (extension_id, key, value) VALUES ('quicklinks', 's1', '\"from A\"')", []).unwrap();
        conn_b.execute("INSERT INTO extension_storage (extension_id, key, value) VALUES ('quicklinks', 's2', '\"from B\"')", []).unwrap();

        let (snap_a, _) = export(&conn_a, "device-a", all_toggles(), &json!({}), None).unwrap();
        let (snap_b, _) = export(&conn_b, "device-b", all_toggles(), &json!({}), None).unwrap();

        apply(&mut conn_a, &merge(&snap_a, std::slice::from_ref(&snap_b))).unwrap();
        apply(&mut conn_b, &merge(&snap_b, std::slice::from_ref(&snap_a))).unwrap();

        let a_has_both: i64 = conn_a.query_row("SELECT COUNT(*) FROM extension_storage WHERE extension_id = 'quicklinks' AND key IN ('s1','s2')", [], |row| row.get(0)).unwrap();
        let b_has_both: i64 = conn_b.query_row("SELECT COUNT(*) FROM extension_storage WHERE extension_id = 'quicklinks' AND key IN ('s1','s2')", [], |row| row.get(0)).unwrap();
        assert_eq!(a_has_both, 2, "A must pick up B's value");
        assert_eq!(b_has_both, 2, "B must pick up A's value");

        // Now delete on B and re-converge — the deletion must propagate to A.
        conn_b.execute("DELETE FROM extension_storage WHERE extension_id = 'quicklinks' AND key = 's2'", []).unwrap();
        let (snap_a2, _) = export(&conn_a, "device-a", all_toggles(), &json!({}), None).unwrap();
        let (snap_b2, _) = export(&conn_b, "device-b", all_toggles(), &json!({}), None).unwrap();

        apply(&mut conn_a, &merge(&snap_a2, std::slice::from_ref(&snap_b2))).unwrap();
        apply(&mut conn_b, &merge(&snap_b2, std::slice::from_ref(&snap_a2))).unwrap();

        let a_has_s2: i64 = conn_a.query_row("SELECT COUNT(*) FROM extension_storage WHERE extension_id = 'quicklinks' AND key = 's2'", [], |row| row.get(0)).unwrap();
        assert_eq!(a_has_s2, 0, "B's delete of s2 must tombstone it on A");
        let a_still_has_s1: i64 = conn_a.query_row("SELECT COUNT(*) FROM extension_storage WHERE extension_id = 'quicklinks' AND key = 's1'", [], |row| row.get(0)).unwrap();
        assert_eq!(a_still_has_s1, 1, "the delete must not take s1 down with it");
    }

    fn snapshot_at_version(device_id: &str, version: u32) -> Snapshot {
        Snapshot { version, device_id: device_id.to_string(), records: vec![], portable_settings: None }
    }

    #[test]
    fn partition_by_version_keeps_the_same_version_and_one_step_either_side() {
        let remotes = vec![snapshot_at_version("same", 5), snapshot_at_version("older", 4), snapshot_at_version("newer", 6)];

        let (usable, outdated) = partition_by_version(5, remotes);

        assert_eq!(usable.iter().map(|s| s.device_id.as_str()).collect::<Vec<_>>(), vec!["same", "older", "newer"]);
        assert!(outdated.is_empty());
    }

    #[test]
    fn partition_by_version_flags_two_versions_old_as_outdated() {
        let remotes = vec![snapshot_at_version("ancient", 3), snapshot_at_version("current", 5)];

        let (usable, outdated) = partition_by_version(5, remotes);

        assert_eq!(usable.iter().map(|s| s.device_id.as_str()).collect::<Vec<_>>(), vec!["current"]);
        assert_eq!(outdated, vec!["ancient".to_string()]);
    }

    #[test]
    fn partition_by_version_flags_a_remote_two_versions_ahead_too() {
        // Symmetric: if the remote is the one that's two waves ahead, this
        // (older) device is the one out of date — same "don't trust it"
        // outcome, from the other side of the gap.
        let remotes = vec![snapshot_at_version("from-the-future", 7)];

        let (usable, outdated) = partition_by_version(5, remotes);

        assert!(usable.is_empty());
        assert_eq!(outdated, vec!["from-the-future".to_string()]);
    }

    /// The scenario T35 exists for: device A has updated (writes/reads
    /// version N), device B hasn't yet (still on N-1) — their data must
    /// still converge both ways during that window, exactly like the
    /// same-version `two_devices_converge_through_export_merge_apply`
    /// test above, just with a version gap of one added to each snapshot.
    #[test]
    fn two_devices_on_adjacent_versions_still_converge_both_ways() {
        let mut conn_a = migrated_conn();
        let mut conn_b = migrated_conn();

        conn_a.execute("INSERT INTO extension_storage (extension_id, key, value) VALUES ('quicklinks', 's1', '\"from updated A\"')", []).unwrap();
        conn_b.execute("INSERT INTO extension_storage (extension_id, key, value) VALUES ('quicklinks', 's2', '\"from old B\"')", []).unwrap();

        let (mut snap_a, _) = export(&conn_a, "device-a", all_toggles(), &json!({}), None).unwrap();
        let (mut snap_b, _) = export(&conn_b, "device-b", all_toggles(), &json!({}), None).unwrap();
        snap_a.version = SNAPSHOT_VERSION + 1; // A already updated to the new wave
        snap_b.version = SNAPSHOT_VERSION; // B hasn't updated yet

        let (usable_for_a, outdated_for_a) = partition_by_version(snap_a.version, vec![snap_b.clone()]);
        assert!(outdated_for_a.is_empty(), "B is only one version behind A, must not be treated as outdated");
        apply(&mut conn_a, &merge(&snap_a, &usable_for_a)).unwrap();

        let (usable_for_b, outdated_for_b) = partition_by_version(snap_b.version, vec![snap_a.clone()]);
        assert!(outdated_for_b.is_empty(), "A is only one version ahead of B, must not be treated as outdated");
        apply(&mut conn_b, &merge(&snap_b, &usable_for_b)).unwrap();

        let a_has_both: i64 = conn_a.query_row("SELECT COUNT(*) FROM extension_storage WHERE extension_id = 'quicklinks' AND key IN ('s1','s2')", [], |row| row.get(0)).unwrap();
        let b_has_both: i64 = conn_b.query_row("SELECT COUNT(*) FROM extension_storage WHERE extension_id = 'quicklinks' AND key IN ('s1','s2')", [], |row| row.get(0)).unwrap();
        assert_eq!(a_has_both, 2, "A (newer) must still pick up B's (older-format) value");
        assert_eq!(b_has_both, 2, "B (older) must still pick up A's (newer-format) value");
    }

    #[test]
    fn merge_prefers_the_settings_record_with_the_newer_timestamp() {
        let local = Snapshot { version: SNAPSHOT_VERSION, device_id: "a".into(), records: vec![], portable_settings: Some(SettingsRecord { updated_at: 1000, fields: json!({"theme": "dark"}) }) };
        let remote =
            Snapshot { version: SNAPSHOT_VERSION, device_id: "b".into(), records: vec![], portable_settings: Some(SettingsRecord { updated_at: 2000, fields: json!({"theme": "light"}) }) };

        let changes = merge(&local, &[remote]);

        assert_eq!(changes.portable_settings.unwrap().fields["theme"], "light");
    }
}
