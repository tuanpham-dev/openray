use std::collections::HashMap;

use rusqlite::params;
use serde::Serialize;

use crate::infrastructure::db::SharedConnection;

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandSettingsEntry {
    pub alias: Option<String>,
    pub hotkey: Option<String>,
    pub enabled: bool,
}

pub struct CommandSettingsStore {
    conn: SharedConnection,
}

impl CommandSettingsStore {
    pub fn new(conn: SharedConnection) -> Self {
        Self { conn }
    }

    pub fn all(&self) -> HashMap<String, CommandSettingsEntry> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT command_id, alias, hotkey, enabled FROM command_settings")
            .expect("valid query");
        let rows = stmt
            .query_map([], |row| {
                let command_id: String = row.get(0)?;
                Ok((
                    command_id,
                    CommandSettingsEntry {
                        alias: row.get(1)?,
                        hotkey: row.get(2)?,
                        enabled: row.get::<_, i64>(3)? != 0,
                    },
                ))
            })
            .expect("valid query");
        rows.filter_map(Result::ok).collect()
    }

    fn ensure_row(conn: &rusqlite::Connection, command_id: &str) -> Result<(), String> {
        conn.execute(
            "INSERT OR IGNORE INTO command_settings (command_id, alias, hotkey, enabled) VALUES (?1, NULL, NULL, 1)",
            params![command_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn set_hotkey(&self, command_id: &str, hotkey: Option<&str>) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        Self::ensure_row(&conn, command_id)?;
        conn.execute(
            "UPDATE command_settings SET hotkey = ?1 WHERE command_id = ?2",
            params![hotkey, command_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Trims and validates `alias` against every *other* command's alias
    /// (case-insensitive, matching how search will match it) before
    /// persisting. `None`/empty clears the alias.
    pub fn set_alias(&self, command_id: &str, alias: Option<&str>) -> Result<(), String> {
        let normalized = alias.map(str::trim).filter(|s| !s.is_empty());

        let conn = self.conn.lock().unwrap();

        if let Some(value) = normalized {
            let existing: Option<String> = conn
                .query_row(
                    "SELECT command_id FROM command_settings WHERE alias IS NOT NULL AND lower(alias) = lower(?1) AND command_id != ?2",
                    params![value, command_id],
                    |row| row.get(0),
                )
                .ok();
            if let Some(other_id) = existing {
                return Err(format!("Alias \"{value}\" is already used by {other_id}"));
            }
        }

        Self::ensure_row(&conn, command_id)?;
        conn.execute(
            "UPDATE command_settings SET alias = ?1 WHERE command_id = ?2",
            params![normalized, command_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn set_enabled(&self, command_id: &str, enabled: bool) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        Self::ensure_row(&conn, command_id)?;
        conn.execute(
            "UPDATE command_settings SET enabled = ?1 WHERE command_id = ?2",
            params![enabled as i64, command_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Deletes every row for commands namespaced under `ext:<extension_id>:`
    /// — called on extension uninstall so stale settings don't linger.
    pub fn delete_for_extension(&self, extension_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        let escaped = extension_id.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
        let prefix = format!("ext:{escaped}:%");
        conn.execute(
            "DELETE FROM command_settings WHERE command_id LIKE ?1 ESCAPE '\\'",
            params![prefix],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use std::sync::{Arc, Mutex};

    fn test_store() -> CommandSettingsStore {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE command_settings (
                command_id TEXT PRIMARY KEY,
                alias TEXT,
                hotkey TEXT,
                enabled INTEGER NOT NULL DEFAULT 1
            );",
        )
        .unwrap();
        CommandSettingsStore::new(Arc::new(Mutex::new(conn)))
    }

    #[test]
    fn set_hotkey_creates_row_and_overwrites() {
        let store = test_store();
        store.set_hotkey("firefox.desktop", Some("Ctrl+Alt+KeyF")).unwrap();
        assert_eq!(store.all()["firefox.desktop"].hotkey.as_deref(), Some("Ctrl+Alt+KeyF"));

        store.set_hotkey("firefox.desktop", Some("Ctrl+Alt+KeyG")).unwrap();
        assert_eq!(store.all()["firefox.desktop"].hotkey.as_deref(), Some("Ctrl+Alt+KeyG"));
    }

    #[test]
    fn set_hotkey_none_clears() {
        let store = test_store();
        store.set_hotkey("firefox.desktop", Some("Ctrl+Alt+KeyF")).unwrap();
        store.set_hotkey("firefox.desktop", None).unwrap();
        assert_eq!(store.all()["firefox.desktop"].hotkey, None);
    }

    #[test]
    fn set_alias_creates_row_and_overwrites() {
        let store = test_store();
        store.set_alias("ext:demo:search", Some("ds")).unwrap();
        assert_eq!(store.all()["ext:demo:search"].alias.as_deref(), Some("ds"));

        store.set_alias("ext:demo:search", Some("dss")).unwrap();
        assert_eq!(store.all()["ext:demo:search"].alias.as_deref(), Some("dss"));
    }

    #[test]
    fn set_alias_rejects_duplicate_case_insensitive() {
        let store = test_store();
        store.set_alias("ext:demo:search", Some("df")).unwrap();
        let err = store.set_alias("ext:other:search", Some("DF")).unwrap_err();
        assert!(err.contains("ext:demo:search"));
    }

    #[test]
    fn set_alias_allows_reassigning_same_command() {
        let store = test_store();
        store.set_alias("ext:demo:search", Some("df")).unwrap();
        assert!(store.set_alias("ext:demo:search", Some("df")).is_ok());
    }

    #[test]
    fn set_alias_none_or_empty_clears() {
        let store = test_store();
        store.set_alias("ext:demo:search", Some("df")).unwrap();
        store.set_alias("ext:demo:search", Some("  ")).unwrap();
        assert_eq!(store.all()["ext:demo:search"].alias, None);
    }

    #[test]
    fn set_enabled_defaults_true_and_toggles() {
        let store = test_store();
        store.set_enabled("firefox.desktop", false).unwrap();
        assert!(!store.all()["firefox.desktop"].enabled);
    }

    #[test]
    fn delete_for_extension_removes_only_its_commands() {
        let store = test_store();
        store.set_hotkey("ext:demo:search", Some("Ctrl+KeyD")).unwrap();
        store.set_hotkey("ext:other:search", Some("Ctrl+KeyO")).unwrap();

        store.delete_for_extension("demo").unwrap();

        let all = store.all();
        assert!(!all.contains_key("ext:demo:search"));
        assert!(all.contains_key("ext:other:search"));
    }
}
