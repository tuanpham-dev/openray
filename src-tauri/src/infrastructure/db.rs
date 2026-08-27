use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use rusqlite::{params, Connection};
use tauri::{AppHandle, Manager};

use crate::error::Error;

pub type SharedConnection = Arc<Mutex<Connection>>;

/// Runs `f` inside one SQLite transaction, committing on `Ok` and rolling
/// back (rusqlite's `Drop` behavior for an uncommitted `Transaction`) on
/// `Err`, so a multi-statement write either lands completely or not at
/// all. A plain trait (not an inherent impl) since `SharedConnection` is
/// a type alias for `Arc<Mutex<Connection>>`, a foreign type.
pub trait WithTransaction {
    fn with_transaction<T>(&self, f: impl FnOnce(&rusqlite::Transaction) -> Result<T, Error>) -> Result<T, Error>;
}

impl WithTransaction for SharedConnection {
    fn with_transaction<T>(&self, f: impl FnOnce(&rusqlite::Transaction) -> Result<T, Error>) -> Result<T, Error> {
        let mut conn = self.lock().unwrap();
        let tx = conn.transaction()?;
        let result = f(&tx)?;
        tx.commit()?;
        Ok(result)
    }
}

const MIGRATIONS: &[(&str, &str)] = &[
    ("0001_init", include_str!("../../migrations/0001_init.sql")),
    ("0002_quicklinks", include_str!("../../migrations/0002_quicklinks.sql")),
    ("0003_snippets", include_str!("../../migrations/0003_snippets.sql")),
    ("0004_clipboard", include_str!("../../migrations/0004_clipboard.sql")),
    ("0005_extensions", include_str!("../../migrations/0005_extensions.sql")),
    (
        "0006_installed_extensions",
        include_str!("../../migrations/0006_installed_extensions.sql"),
    ),
    (
        "0007_extension_preferences",
        include_str!("../../migrations/0007_extension_preferences.sql"),
    ),
    (
        "0008_command_settings",
        include_str!("../../migrations/0008_command_settings.sql"),
    ),
    (
        "0009_clipboard_images",
        include_str!("../../migrations/0009_clipboard_images.sql"),
    ),
    (
        "0010_extension_storage",
        include_str!("../../migrations/0010_extension_storage.sql"),
    ),
    (
        "0011_window_commands",
        include_str!("../../migrations/0011_window_commands.sql"),
    ),
    (
        "0012_screenshot_ocr",
        include_str!("../../migrations/0012_screenshot_ocr.sql"),
    ),
    (
        "0013_screenshot_thumbnails",
        include_str!("../../migrations/0013_screenshot_thumbnails.sql"),
    ),
    ("0014_translate", include_str!("../../migrations/0014_translate.sql")),
    ("0015_notes", include_str!("../../migrations/0015_notes.sql")),
    ("0016_ai", include_str!("../../migrations/0016_ai.sql")),
    ("0017_ai_extended", include_str!("../../migrations/0017_ai_extended.sql")),
    ("0018_sync", include_str!("../../migrations/0018_sync.sql")),
    (
        "0019_named_webpage_question",
        include_str!("../../migrations/0019_named_webpage_question.sql"),
    ),
    (
        "0020_extension_command_arguments",
        include_str!("../../migrations/0020_extension_command_arguments.sql"),
    ),
    (
        "0021_quicklinks_to_extension_storage",
        include_str!("../../migrations/0021_quicklinks_to_extension_storage.sql"),
    ),
    (
        "0022_snippets_to_extension_storage",
        include_str!("../../migrations/0022_snippets_to_extension_storage.sql"),
    ),
    (
        "0023_window_commands_to_extension_storage",
        include_str!("../../migrations/0023_window_commands_to_extension_storage.sql"),
    ),
    (
        "0024_translate_to_extension_storage",
        include_str!("../../migrations/0024_translate_to_extension_storage.sql"),
    ),
    (
        "0025_notes_to_extension_storage",
        include_str!("../../migrations/0025_notes_to_extension_storage.sql"),
    ),
    (
        "0026_exclude_secret_keys_from_extension_storage_sync",
        include_str!("../../migrations/0026_exclude_secret_keys_from_extension_storage_sync.sql"),
    ),
    (
        "0027_retire_migrated_native_tables",
        include_str!("../../migrations/0027_retire_migrated_native_tables.sql"),
    ),
    (
        "0028_extension_icon",
        include_str!("../../migrations/0028_extension_icon.sql"),
    ),
    (
        "0029_screenshot_pins",
        include_str!("../../migrations/0029_screenshot_pins.sql"),
    ),
    (
        "0030_file_search",
        include_str!("../../migrations/0030_file_search.sql"),
    ),
];

pub fn open(app: &AppHandle) -> Result<SharedConnection, Box<dyn std::error::Error>> {
    let data_dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&data_dir)?;
    let conn = Connection::open(data_dir.join("openray.db"))?;
    run_migrations(&conn)?;
    Ok(Arc::new(Mutex::new(conn)))
}

fn run_migrations(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
    )?;

    for (name, sql) in MIGRATIONS {
        let already_applied: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM _migrations WHERE name = ?1)",
            [name],
            |row| row.get(0),
        )?;

        if !already_applied {
            conn.execute_batch(sql)?;
            conn.execute(
                "INSERT INTO _migrations (name, applied_at) VALUES (?1, strftime('%s', 'now'))",
                [name],
            )?;
        }
    }

    Ok(())
}

pub struct UsageRepository {
    conn: SharedConnection,
}

impl UsageRepository {
    pub fn new(conn: SharedConnection) -> Self {
        Self { conn }
    }

    pub fn record_usage(&self, command_id: &str, now: i64) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO usage (command_id, hits, last_used_at) VALUES (?1, 1, ?2)
             ON CONFLICT(command_id) DO UPDATE SET hits = hits + 1, last_used_at = ?2",
            params![command_id, now],
        )?;
        Ok(())
    }

    pub fn all_usage(&self) -> rusqlite::Result<HashMap<String, (u32, i64)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT command_id, hits, last_used_at FROM usage")?;
        let rows = stmt.query_map([], |row| {
            let command_id: String = row.get(0)?;
            let hits: u32 = row.get(1)?;
            let last_used_at: i64 = row.get(2)?;
            Ok((command_id, (hits, last_used_at)))
        })?;
        rows.collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shared_conn_with_table() -> SharedConnection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL)").unwrap();
        Arc::new(Mutex::new(conn))
    }

    #[test]
    fn with_transaction_commits_every_statement_on_ok() {
        let shared = shared_conn_with_table();
        shared
            .with_transaction(|tx| {
                tx.execute("INSERT INTO t (name) VALUES ('a')", [])?;
                tx.execute("INSERT INTO t (name) VALUES ('b')", [])?;
                Ok(())
            })
            .unwrap();

        let count: i64 = shared.lock().unwrap().query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn with_transaction_rolls_back_every_statement_on_err() {
        let shared = shared_conn_with_table();
        let result: Result<(), Error> = shared.with_transaction(|tx| {
            tx.execute("INSERT INTO t (name) VALUES ('a')", [])?;
            tx.execute("INSERT INTO t (name) VALUES ('b')", [])?;
            Err(Error::msg("simulated failure after both inserts"))
        });

        assert!(result.is_err());
        let count: i64 = shared.lock().unwrap().query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 0, "neither insert should be visible after a rollback");
    }

    #[test]
    fn with_transaction_returns_the_closures_value_on_success() {
        let shared = shared_conn_with_table();
        let id = shared
            .with_transaction(|tx| {
                tx.execute("INSERT INTO t (name) VALUES ('a')", [])?;
                Ok(tx.last_insert_rowid())
            })
            .unwrap();
        assert_eq!(id, 1);
    }

    #[test]
    fn all_migrations_apply_cleanly_to_a_fresh_database() {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();

        let sync_meta_exists: bool = conn
            .query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='sync_meta')", [], |row| row.get(0))
            .unwrap();
        assert!(sync_meta_exists);
    }

    /// Simulates an upgrading user: every migration except 0018 has already
    /// run and the user already has data, then 0018 lands on top of it.
    /// Triggers created by 0018 don't fire retroactively for rows that
    /// existed before them, so this exercises the migration's explicit
    /// backfill INSERTs, not just its trigger definitions.
    #[test]
    fn migration_0018_backfills_sync_meta_for_pre_existing_rows() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
        )
        .unwrap();
        for (name, sql) in MIGRATIONS {
            // T26: 0025 has a genuine dependency on 0018's own effect (it
            // reads/writes the `sync_id` column 0018 adds) — unlike
            // 0021-0024, which never touch that column, so this is the
            // first later migration this isolation trick needs to skip
            // too when testing 0018 alone. T27: 0026 depends on 0018 too
            // (its `DELETE FROM sync_meta` needs that table to already
            // exist — 0018 is what creates it), same reason. T31 (0027)
            // must be skipped too — it drops the very `notes`/`snippets`
            // tables this test inserts into below, and applying it via
            // `run_migrations` at the end (which runs every still-pending
            // migration, not just 0018) would otherwise drop them out
            // from under this test before its assertions run.
            if *name == "0018_sync"
                || *name == "0025_notes_to_extension_storage"
                || *name == "0026_exclude_secret_keys_from_extension_storage_sync"
                || *name == "0027_retire_migrated_native_tables"
            {
                continue;
            }
            conn.execute_batch(sql).unwrap();
            conn.execute("INSERT INTO _migrations (name, applied_at) VALUES (?1, 0)", [name]).unwrap();
        }

        conn.execute(
            "INSERT INTO notes (content, created_at, updated_at, last_opened_at) VALUES ('hello', 1, 1, 1), ('world', 2, 2, 2)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO snippets (id, name, keyword, body, created_at) VALUES ('snippet.1', 'sig', NULL, 'body', 1)",
            [],
        )
        .unwrap();

        // Apply only 0018 itself, not `run_migrations` to head — that
        // would also apply the now-pending 0027 in the same call and drop
        // `notes`/`snippets` before this test's own assertions run.
        conn.execute_batch(include_str!("../../migrations/0018_sync.sql")).unwrap();
        conn.execute("INSERT INTO _migrations (name, applied_at) VALUES ('0018_sync', 0)", []).unwrap();

        let notes_distinct_sync_ids: i64 = conn.query_row("SELECT COUNT(DISTINCT sync_id) FROM notes", [], |row| row.get(0)).unwrap();
        assert_eq!(notes_distinct_sync_ids, 2, "each pre-existing note must get its own backfilled sync_id");

        let notes_sync_meta_rows: i64 = conn.query_row("SELECT COUNT(*) FROM sync_meta WHERE kind = 'notes'", [], |row| row.get(0)).unwrap();
        assert_eq!(notes_sync_meta_rows, 2, "pre-existing notes must be visible to the first sync without being edited first");

        let snippets_sync_meta_rows: i64 = conn.query_row("SELECT COUNT(*) FROM sync_meta WHERE kind = 'snippets'", [], |row| row.get(0)).unwrap();
        assert_eq!(snippets_sync_meta_rows, 1);
    }

    /// Simulates an upgrading user with pre-existing quicklinks: every
    /// migration except 0021 has already run and a quicklink already
    /// exists, then 0021 lands on top of it — mirrors
    /// `migration_0018_backfills_sync_meta_for_pre_existing_rows`'s
    /// pattern for the same reason (a fresh `run_migrations` call can't
    /// exercise "data existed before this migration ran" on its own).
    #[test]
    fn migration_0021_copies_pre_existing_quicklinks_into_extension_storage() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
        )
        .unwrap();
        for (name, sql) in MIGRATIONS {
            // T31 (0027) must be skipped too — it drops the `quicklinks`
            // table this test inserts into below; see the same note on
            // `migration_0018_backfills_sync_meta_for_pre_existing_rows`.
            if *name == "0021_quicklinks_to_extension_storage" || *name == "0027_retire_migrated_native_tables" {
                continue;
            }
            conn.execute_batch(sql).unwrap();
            conn.execute("INSERT INTO _migrations (name, applied_at) VALUES (?1, 0)", [name]).unwrap();
        }

        conn.execute(
            "INSERT INTO quicklinks (id, title, url_template, icon, created_at) VALUES ('quicklink.1', 'GitHub', 'https://github.com/{query}', NULL, 1000)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO quicklinks (id, title, url_template, icon, created_at) VALUES ('quicklink.2', 'Docs', 'https://docs.test', 'icon.png', 2000)",
            [],
        )
        .unwrap();

        conn.execute_batch(include_str!("../../migrations/0021_quicklinks_to_extension_storage.sql")).unwrap();
        conn.execute("INSERT INTO _migrations (name, applied_at) VALUES ('0021_quicklinks_to_extension_storage', 0)", []).unwrap();

        let storage_rows: i64 =
            conn.query_row("SELECT COUNT(*) FROM extension_storage WHERE extension_id = 'quicklinks'", [], |row| row.get(0)).unwrap();
        assert_eq!(storage_rows, 2, "every pre-existing quicklink must get an extension_storage row");

        // The stored column must hold the JSON-*string*-encoded form (what
        // `extension_storage::get`/`all` decode back to a Value::String,
        // exactly like a live `LocalStorage.setItem(key, JSON.stringify(x))`
        // write would have stored) — not a bare JSON object — or the
        // extension's own `LocalStorage.allItems()` + `JSON.parse` round
        // trip silently drops every migrated row (see `resolve` param
        // decoding on the TS side). One `serde_json::from_str` unwraps the
        // outer string encoding; a second parses the JSON text it contains.
        let value: String = conn
            .query_row("SELECT value FROM extension_storage WHERE extension_id = 'quicklinks' AND key = 'quicklink.1'", [], |row| row.get(0))
            .unwrap();
        let decoded: serde_json::Value = serde_json::from_str(&value).unwrap();
        let inner_json = decoded.as_str().expect("stored value must decode to a JSON string, matching LocalStorage's own contract");
        let parsed: serde_json::Value = serde_json::from_str(inner_json).unwrap();
        assert_eq!(parsed["id"], "quicklink.1");
        assert_eq!(parsed["title"], "GitHub");
        assert_eq!(parsed["urlTemplate"], "https://github.com/{query}");
        assert!(parsed["icon"].is_null());
        assert_eq!(parsed["createdAt"], 1000);

        let sync_meta_rows: i64 =
            conn.query_row("SELECT COUNT(*) FROM sync_meta WHERE kind = 'extension_storage' AND id LIKE 'quicklinks:%'", [], |row| row.get(0)).unwrap();
        assert_eq!(sync_meta_rows, 2, "the extension_storage insert trigger must stamp sync_meta for each migrated row, same as any live write");
    }

    /// A migration that only ever runs once per database (tracked by
    /// `_migrations`) must still be safe to re-apply its SQL directly —
    /// `INSERT OR IGNORE` rather than a fragile NOT-IN guard, so a
    /// hypothetical re-run (or a future migration copy-pasting this
    /// pattern) can't double-insert or panic on the PRIMARY KEY conflict.
    #[test]
    fn migration_0021_sql_is_idempotent_if_ever_re_run() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
        )
        .unwrap();
        // Stop right after 0021 itself, not `run_migrations` to head — 0027
        // (T31) drops `quicklinks` a few migrations later, which would
        // leave nothing for this test's own INSERT below to target.
        for (name, sql) in MIGRATIONS {
            conn.execute_batch(sql).unwrap();
            conn.execute("INSERT INTO _migrations (name, applied_at) VALUES (?1, 0)", [name]).unwrap();
            if *name == "0021_quicklinks_to_extension_storage" {
                break;
            }
        }
        conn.execute(
            "INSERT INTO quicklinks (id, title, url_template, icon, created_at) VALUES ('quicklink.1', 'GitHub', 'https://github.com', NULL, 1000)",
            [],
        )
        .unwrap();
        conn.execute_batch(include_str!("../../migrations/0021_quicklinks_to_extension_storage.sql")).unwrap();
        conn.execute_batch(include_str!("../../migrations/0021_quicklinks_to_extension_storage.sql")).unwrap();

        let storage_rows: i64 =
            conn.query_row("SELECT COUNT(*) FROM extension_storage WHERE extension_id = 'quicklinks'", [], |row| row.get(0)).unwrap();
        assert_eq!(storage_rows, 1);
    }

    /// Mirrors `migration_0021_copies_pre_existing_quicklinks_into_extension_storage`
    /// for T16's snippets migration.
    #[test]
    fn migration_0022_copies_pre_existing_snippets_into_extension_storage() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
        )
        .unwrap();
        for (name, sql) in MIGRATIONS {
            // T31 (0027) must be skipped too — it drops the `snippets`
            // table this test inserts into below; see the same note on
            // `migration_0018_backfills_sync_meta_for_pre_existing_rows`.
            if *name == "0022_snippets_to_extension_storage" || *name == "0027_retire_migrated_native_tables" {
                continue;
            }
            conn.execute_batch(sql).unwrap();
            conn.execute("INSERT INTO _migrations (name, applied_at) VALUES (?1, 0)", [name]).unwrap();
        }

        conn.execute(
            "INSERT INTO snippets (id, name, keyword, body, created_at) VALUES ('snippet.1', 'Signature', 'sig', 'Best regards,\nTuan', 1000)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO snippets (id, name, keyword, body, created_at) VALUES ('snippet.2', 'Todo', NULL, 'TODO: {argument}', 2000)",
            [],
        )
        .unwrap();

        conn.execute_batch(include_str!("../../migrations/0022_snippets_to_extension_storage.sql")).unwrap();
        conn.execute("INSERT INTO _migrations (name, applied_at) VALUES ('0022_snippets_to_extension_storage', 0)", []).unwrap();

        let storage_rows: i64 =
            conn.query_row("SELECT COUNT(*) FROM extension_storage WHERE extension_id = 'snippets'", [], |row| row.get(0)).unwrap();
        assert_eq!(storage_rows, 2, "every pre-existing snippet must get an extension_storage row");

        let value: String = conn
            .query_row("SELECT value FROM extension_storage WHERE extension_id = 'snippets' AND key = 'snippet.1'", [], |row| row.get(0))
            .unwrap();
        let decoded: serde_json::Value = serde_json::from_str(&value).unwrap();
        let inner_json = decoded.as_str().expect("stored value must decode to a JSON string, matching LocalStorage's own contract");
        let parsed: serde_json::Value = serde_json::from_str(inner_json).unwrap();
        assert_eq!(parsed["id"], "snippet.1");
        assert_eq!(parsed["name"], "Signature");
        assert_eq!(parsed["keyword"], "sig");
        assert_eq!(parsed["body"], "Best regards,\nTuan");
        assert_eq!(parsed["createdAt"], 1000);

        let value2: String = conn
            .query_row("SELECT value FROM extension_storage WHERE extension_id = 'snippets' AND key = 'snippet.2'", [], |row| row.get(0))
            .unwrap();
        let decoded2: serde_json::Value = serde_json::from_str(&value2).unwrap();
        let inner_json2 = decoded2.as_str().unwrap();
        let parsed2: serde_json::Value = serde_json::from_str(inner_json2).unwrap();
        assert!(parsed2["keyword"].is_null(), "a snippet with no keyword must round-trip as null, not a missing/empty string");

        let sync_meta_rows: i64 =
            conn.query_row("SELECT COUNT(*) FROM sync_meta WHERE kind = 'extension_storage' AND id LIKE 'snippets:%'", [], |row| row.get(0)).unwrap();
        assert_eq!(sync_meta_rows, 2, "the extension_storage insert trigger must stamp sync_meta for each migrated row, same as any live write");
    }

    #[test]
    fn migration_0022_sql_is_idempotent_if_ever_re_run() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
        )
        .unwrap();
        for (name, sql) in MIGRATIONS {
            conn.execute_batch(sql).unwrap();
            conn.execute("INSERT INTO _migrations (name, applied_at) VALUES (?1, 0)", [name]).unwrap();
            if *name == "0022_snippets_to_extension_storage" {
                break;
            }
        }
        conn.execute(
            "INSERT INTO snippets (id, name, keyword, body, created_at) VALUES ('snippet.1', 'Signature', NULL, 'Best regards', 1000)",
            [],
        )
        .unwrap();
        conn.execute_batch(include_str!("../../migrations/0022_snippets_to_extension_storage.sql")).unwrap();
        conn.execute_batch(include_str!("../../migrations/0022_snippets_to_extension_storage.sql")).unwrap();

        let storage_rows: i64 =
            conn.query_row("SELECT COUNT(*) FROM extension_storage WHERE extension_id = 'snippets'", [], |row| row.get(0)).unwrap();
        assert_eq!(storage_rows, 1);
    }

    /// Mirrors `migration_0022_copies_pre_existing_snippets_into_extension_storage`
    /// for T18's window-commands migration.
    #[test]
    fn migration_0023_copies_pre_existing_window_commands_into_extension_storage() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
        )
        .unwrap();
        for (name, sql) in MIGRATIONS {
            // T31 (0027) must be skipped too — it drops the
            // `window_commands` table this test inserts into below; see
            // the same note on
            // `migration_0018_backfills_sync_meta_for_pre_existing_rows`.
            if *name == "0023_window_commands_to_extension_storage" || *name == "0027_retire_migrated_native_tables" {
                continue;
            }
            conn.execute_batch(sql).unwrap();
            conn.execute("INSERT INTO _migrations (name, applied_at) VALUES (?1, 0)", [name]).unwrap();
        }

        conn.execute(
            "INSERT INTO window_commands (id, title, unit, x, y, width, height, created_at) VALUES ('window.custom.1', 'My Layout', 'percent', 10.0, 20.0, 50.0, 60.0, 1000)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO window_commands (id, title, unit, x, y, width, height, created_at) VALUES ('window.custom.2', 'Centered', 'pixels', NULL, NULL, 400.0, 300.0, 2000)",
            [],
        )
        .unwrap();

        conn.execute_batch(include_str!("../../migrations/0023_window_commands_to_extension_storage.sql")).unwrap();
        conn.execute("INSERT INTO _migrations (name, applied_at) VALUES ('0023_window_commands_to_extension_storage', 0)", []).unwrap();

        let storage_rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM extension_storage WHERE extension_id = 'window-management'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(storage_rows, 2, "every pre-existing window command must get an extension_storage row");

        let value: String = conn
            .query_row(
                "SELECT value FROM extension_storage WHERE extension_id = 'window-management' AND key = 'window.custom.1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let decoded: serde_json::Value = serde_json::from_str(&value).unwrap();
        let inner_json = decoded.as_str().expect("stored value must decode to a JSON string, matching LocalStorage's own contract");
        let parsed: serde_json::Value = serde_json::from_str(inner_json).unwrap();
        assert_eq!(parsed["id"], "window.custom.1");
        assert_eq!(parsed["title"], "My Layout");
        assert_eq!(parsed["unit"], "percent");
        assert_eq!(parsed["x"], 10.0);
        assert_eq!(parsed["y"], 20.0);
        assert_eq!(parsed["width"], 50.0);
        assert_eq!(parsed["height"], 60.0);
        assert_eq!(parsed["createdAt"], 1000);

        let value2: String = conn
            .query_row(
                "SELECT value FROM extension_storage WHERE extension_id = 'window-management' AND key = 'window.custom.2'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let decoded2: serde_json::Value = serde_json::from_str(&value2).unwrap();
        let inner_json2 = decoded2.as_str().unwrap();
        let parsed2: serde_json::Value = serde_json::from_str(inner_json2).unwrap();
        assert!(parsed2["x"].is_null(), "a command with no x must round-trip as null, not a missing/zero value");
        assert!(parsed2["y"].is_null(), "a command with no y must round-trip as null, not a missing/zero value");

        let sync_meta_rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_meta WHERE kind = 'extension_storage' AND id LIKE 'window-management:%'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(sync_meta_rows, 2, "the extension_storage insert trigger must stamp sync_meta for each migrated row, same as any live write");
    }

    #[test]
    fn migration_0023_sql_is_idempotent_if_ever_re_run() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
        )
        .unwrap();
        for (name, sql) in MIGRATIONS {
            conn.execute_batch(sql).unwrap();
            conn.execute("INSERT INTO _migrations (name, applied_at) VALUES (?1, 0)", [name]).unwrap();
            if *name == "0023_window_commands_to_extension_storage" {
                break;
            }
        }
        conn.execute(
            "INSERT INTO window_commands (id, title, unit, x, y, width, height, created_at) VALUES ('window.custom.1', 'My Layout', 'pixels', NULL, NULL, 400.0, 300.0, 1000)",
            [],
        )
        .unwrap();
        conn.execute_batch(include_str!("../../migrations/0023_window_commands_to_extension_storage.sql")).unwrap();
        conn.execute_batch(include_str!("../../migrations/0023_window_commands_to_extension_storage.sql")).unwrap();

        let storage_rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM extension_storage WHERE extension_id = 'window-management'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(storage_rows, 1);
    }

    #[test]
    fn migration_0024_copies_pre_existing_translate_commands_and_history_into_extension_storage() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
        )
        .unwrap();
        for (name, sql) in MIGRATIONS {
            // T31 (0027) must be skipped too — it drops
            // `translate_commands`/`translate_history`, and this test
            // queries `translate_history` directly after migrating; see
            // the same note on
            // `migration_0018_backfills_sync_meta_for_pre_existing_rows`.
            if *name == "0024_translate_to_extension_storage" || *name == "0027_retire_migrated_native_tables" {
                continue;
            }
            conn.execute_batch(sql).unwrap();
            conn.execute("INSERT INTO _migrations (name, applied_at) VALUES (?1, 0)", [name]).unwrap();
        }

        conn.execute(
            "INSERT INTO translate_commands (id, title, source_lang, target_lang, created_at) VALUES ('translate.custom.1', 'To French', 'auto', 'fr', 1000)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO translate_history (source_text, translated_text, detected_lang, target_lang, created_at) VALUES ('hello', 'Hallo', 'en', 'de', 2000)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO translate_history (source_text, translated_text, detected_lang, target_lang, created_at) VALUES ('world', 'Welt', NULL, 'de', 3000)",
            [],
        )
        .unwrap();

        conn.execute_batch(include_str!("../../migrations/0024_translate_to_extension_storage.sql")).unwrap();
        conn.execute("INSERT INTO _migrations (name, applied_at) VALUES ('0024_translate_to_extension_storage', 0)", []).unwrap();

        let storage_rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM extension_storage WHERE extension_id = 'translate'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(storage_rows, 3, "every pre-existing custom command and history entry must get an extension_storage row");

        let pair_value: String = conn
            .query_row(
                "SELECT value FROM extension_storage WHERE extension_id = 'translate' AND key = 'pair:translate.custom.1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let pair_decoded: serde_json::Value = serde_json::from_str(&pair_value).unwrap();
        let pair_inner = pair_decoded.as_str().expect("stored value must decode to a JSON string, matching LocalStorage's own contract");
        let pair_parsed: serde_json::Value = serde_json::from_str(pair_inner).unwrap();
        assert_eq!(pair_parsed["id"], "translate.custom.1");
        assert_eq!(pair_parsed["title"], "To French");
        assert_eq!(pair_parsed["sourceLang"], "auto");
        assert_eq!(pair_parsed["targetLang"], "fr");
        assert_eq!(pair_parsed["createdAt"], 1000);

        let history_row_id: i64 = conn
            .query_row("SELECT id FROM translate_history WHERE source_text = 'world'", [], |row| row.get(0))
            .unwrap();
        let history_value: String = conn
            .query_row(
                "SELECT value FROM extension_storage WHERE extension_id = 'translate' AND key = ?1",
                [format!("history:{history_row_id}")],
                |row| row.get(0),
            )
            .unwrap();
        let history_decoded: serde_json::Value = serde_json::from_str(&history_value).unwrap();
        let history_inner = history_decoded.as_str().unwrap();
        let history_parsed: serde_json::Value = serde_json::from_str(history_inner).unwrap();
        assert_eq!(history_parsed["id"], history_row_id.to_string(), "the autoincrement id must round-trip as a string, matching extension_storage's TEXT key");
        assert_eq!(history_parsed["sourceText"], "world");
        assert_eq!(history_parsed["translatedText"], "Welt");
        assert!(history_parsed["detectedLang"].is_null(), "a history row with no detected language must round-trip as null");

        let sync_meta_rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_meta WHERE kind = 'extension_storage' AND id LIKE 'translate:%'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(sync_meta_rows, 3, "the extension_storage insert trigger must stamp sync_meta for each migrated row, same as any live write");
    }

    #[test]
    fn migration_0024_sql_is_idempotent_if_ever_re_run() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
        )
        .unwrap();
        for (name, sql) in MIGRATIONS {
            conn.execute_batch(sql).unwrap();
            conn.execute("INSERT INTO _migrations (name, applied_at) VALUES (?1, 0)", [name]).unwrap();
            if *name == "0024_translate_to_extension_storage" {
                break;
            }
        }
        conn.execute(
            "INSERT INTO translate_commands (id, title, source_lang, target_lang, created_at) VALUES ('translate.custom.1', 'To French', 'auto', 'fr', 1000)",
            [],
        )
        .unwrap();
        conn.execute_batch(include_str!("../../migrations/0024_translate_to_extension_storage.sql")).unwrap();
        conn.execute_batch(include_str!("../../migrations/0024_translate_to_extension_storage.sql")).unwrap();

        let storage_rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM extension_storage WHERE extension_id = 'translate'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(storage_rows, 1);
    }

    #[test]
    fn migration_0025_copies_pre_existing_notes_into_extension_storage_keyed_by_sync_id() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
        )
        .unwrap();
        for (name, sql) in MIGRATIONS {
            // T31 (0027) must be skipped too — it drops `notes`, and this
            // test queries `notes` directly after migrating; see the same
            // note on
            // `migration_0018_backfills_sync_meta_for_pre_existing_rows`.
            if *name == "0025_notes_to_extension_storage" || *name == "0027_retire_migrated_native_tables" {
                continue;
            }
            conn.execute_batch(sql).unwrap();
            conn.execute("INSERT INTO _migrations (name, applied_at) VALUES (?1, 0)", [name]).unwrap();
        }

        // Deliberately omits `sync_id` — a plain insert (matching how
        // `application::notes::insert_note` itself writes a row) leaves it
        // NULL, exactly the "never synced yet" case this migration's own
        // doc comment backfills before keying on it.
        conn.execute(
            "INSERT INTO notes (content, pinned_at, created_at, updated_at, last_opened_at) VALUES ('buy milk', 5000, 1000, 2000, 3000)",
            [],
        )
        .unwrap();

        conn.execute_batch(include_str!("../../migrations/0025_notes_to_extension_storage.sql")).unwrap();
        conn.execute("INSERT INTO _migrations (name, applied_at) VALUES ('0025_notes_to_extension_storage', 0)", []).unwrap();

        let sync_id: String = conn.query_row("SELECT sync_id FROM notes", [], |row| row.get(0)).unwrap();
        assert!(!sync_id.is_empty(), "a NULL sync_id must be backfilled, not left unmigrated");

        let value: String = conn
            .query_row("SELECT value FROM extension_storage WHERE extension_id = 'notes' AND key = ?1", [format!("note:{sync_id}")], |row| row.get(0))
            .unwrap();
        let decoded: serde_json::Value = serde_json::from_str(&value).unwrap();
        let inner = decoded.as_str().expect("stored value must decode to a JSON string, matching LocalStorage's own contract");
        let parsed: serde_json::Value = serde_json::from_str(inner).unwrap();
        assert_eq!(parsed["id"], sync_id);
        assert_eq!(parsed["content"], "buy milk");
        assert_eq!(parsed["pinnedAt"], 5000);
        assert_eq!(parsed["createdAt"], 1000);
        assert_eq!(parsed["updatedAt"], 2000);
        assert_eq!(parsed["lastOpenedAt"], 3000);
    }

    #[test]
    fn migration_0025_sql_is_idempotent_if_ever_re_run() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
        )
        .unwrap();
        for (name, sql) in MIGRATIONS {
            conn.execute_batch(sql).unwrap();
            conn.execute("INSERT INTO _migrations (name, applied_at) VALUES (?1, 0)", [name]).unwrap();
            if *name == "0025_notes_to_extension_storage" {
                break;
            }
        }
        conn.execute(
            "INSERT INTO notes (content, pinned_at, created_at, updated_at, last_opened_at) VALUES ('x', NULL, 1000, 1000, 1000)",
            [],
        )
        .unwrap();
        conn.execute_batch(include_str!("../../migrations/0025_notes_to_extension_storage.sql")).unwrap();
        conn.execute_batch(include_str!("../../migrations/0025_notes_to_extension_storage.sql")).unwrap();

        let storage_rows: i64 =
            conn.query_row("SELECT COUNT(*) FROM extension_storage WHERE extension_id = 'notes'", [], |row| row.get(0)).unwrap();
        assert_eq!(storage_rows, 1);
    }

    #[test]
    fn migration_0026_excludes_secret_prefixed_keys_from_sync_meta() {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();

        conn.execute("INSERT INTO extension_storage (extension_id, key, value) VALUES ('ai', 'secret:provider-key:anthropic', '\"sk-live\"')", []).unwrap();
        conn.execute("INSERT INTO extension_storage (extension_id, key, value) VALUES ('ai', 'chat:1', '\"{}\"')", []).unwrap();

        let secret_synced: i64 = conn.query_row("SELECT COUNT(*) FROM sync_meta WHERE kind = 'extension_storage' AND id = 'ai:secret:provider-key:anthropic'", [], |row| row.get(0)).unwrap();
        assert_eq!(secret_synced, 0, "a secret-prefixed key must never get a sync_meta row");

        let normal_synced: i64 = conn.query_row("SELECT COUNT(*) FROM sync_meta WHERE kind = 'extension_storage' AND id = 'ai:chat:1'", [], |row| row.get(0)).unwrap();
        assert_eq!(normal_synced, 1, "a normal key must still be tracked for sync");
    }

    #[test]
    fn migration_0026_cleans_up_any_pre_existing_secret_sync_meta_rows() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
        )
        .unwrap();
        for (name, sql) in MIGRATIONS {
            if *name == "0026_exclude_secret_keys_from_extension_storage_sync" {
                continue;
            }
            conn.execute_batch(sql).unwrap();
            conn.execute("INSERT INTO _migrations (name, applied_at) VALUES (?1, 0)", [name]).unwrap();
        }
        // Before 0026, the original unguarded trigger stamps a sync_meta
        // row for a secret-prefixed key same as any other.
        conn.execute("INSERT INTO extension_storage (extension_id, key, value) VALUES ('ai', 'secret:provider-key:anthropic', '\"sk-live\"')", []).unwrap();
        let pre: i64 = conn.query_row("SELECT COUNT(*) FROM sync_meta WHERE kind = 'extension_storage' AND id = 'ai:secret:provider-key:anthropic'", [], |row| row.get(0)).unwrap();
        assert_eq!(pre, 1);

        run_migrations(&conn).unwrap();

        let post: i64 = conn.query_row("SELECT COUNT(*) FROM sync_meta WHERE kind = 'extension_storage' AND id = 'ai:secret:provider-key:anthropic'", [], |row| row.get(0)).unwrap();
        assert_eq!(post, 0, "0026 must retroactively clean up any secret key that synced before it existed");
    }

    /// Equivalent coverage to the pre-T31 `a_snippet_insert_and_delete_
    /// stamp_sync_meta`/`editing_a_note_after_backfill_...` tests (removed
    /// when 0027 dropped `snippets`/`notes` themselves) — same
    /// insert-then-delete-stamps-a-tombstone invariant, exercised against
    /// `extension_storage`, a table that's still live post-retirement.
    #[test]
    fn an_extension_storage_insert_and_delete_stamp_sync_meta() {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();

        conn.execute("INSERT INTO extension_storage (extension_id, key, value) VALUES ('quicklinks', 'quicklink.1', '\"body\"')", []).unwrap();
        let deleted: i64 = conn
            .query_row("SELECT deleted FROM sync_meta WHERE kind = 'extension_storage' AND id = 'quicklinks:quicklink.1'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(deleted, 0);

        conn.execute("DELETE FROM extension_storage WHERE extension_id = 'quicklinks' AND key = 'quicklink.1'", []).unwrap();
        let deleted: i64 = conn
            .query_row("SELECT deleted FROM sync_meta WHERE kind = 'extension_storage' AND id = 'quicklinks:quicklink.1'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(deleted, 1);
    }

    /// `0027_retire_migrated_native_tables` drops six tables in one
    /// migration on top of a fresh (or any pre-existing) database — the
    /// only assertion worth making at the `run_migrations`-to-head level,
    /// since every other invariant about *what* it drops is already
    /// covered by the individual per-migration tests above that stop
    /// their own migration chain right before 0027 runs.
    #[test]
    fn migration_0027_drops_all_six_retired_native_tables() {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();

        for table in ["notes", "snippets", "quicklinks", "window_commands", "translate_commands", "translate_history"] {
            let result = conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get::<_, i64>(0));
            assert!(result.is_err(), "{table} must no longer exist after a fresh install runs every migration through 0027");
        }

        let leftover_sync_meta: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sync_meta WHERE kind IN ('notes', 'snippets', 'quicklinks', 'window_commands', 'translate_commands', 'translate_history')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(leftover_sync_meta, 0, "0027 must also clear out any sync_meta rows still tagged with a retired kind");
    }
}
