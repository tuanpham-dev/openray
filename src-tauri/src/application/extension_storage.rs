//! `LocalStorage` for extensions.
//!
//! Rows are keyed by (extension_id, key): the id comes from the shim's
//! command context on every call, so one extension can never read or
//! clear another's data. Values are stored as JSON — the API's value type
//! is `string | number | boolean`, and a plain TEXT column would collapse
//! `42` and `"42"` into the same thing on the way back out.

use rusqlite::params;
use serde_json::Value;

use crate::infrastructure::db::SharedConnection;

pub struct ExtensionStorage {
    conn: SharedConnection,
}

impl ExtensionStorage {
    pub fn new(conn: SharedConnection) -> Self {
        Self { conn }
    }

    pub fn get(&self, extension_id: &str, key: &str) -> Result<Value, String> {
        let conn = self.conn.lock().unwrap();
        let raw: Option<String> = conn
            .query_row(
                "SELECT value FROM extension_storage WHERE extension_id = ?1 AND key = ?2",
                params![extension_id, key],
                |row| row.get(0),
            )
            .ok();
        Ok(raw.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null))
    }

    pub fn set(&self, extension_id: &str, key: &str, value: &Value) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO extension_storage (extension_id, key, value) VALUES (?1, ?2, ?3)
             ON CONFLICT(extension_id, key) DO UPDATE SET value = ?3",
            params![extension_id, key, value.to_string()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn remove(&self, extension_id: &str, key: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM extension_storage WHERE extension_id = ?1 AND key = ?2",
            params![extension_id, key],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn all(&self, extension_id: &str) -> Result<Value, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT key, value FROM extension_storage WHERE extension_id = ?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![extension_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;

        let mut map = serde_json::Map::new();
        for row in rows.filter_map(Result::ok) {
            if let Ok(value) = serde_json::from_str(&row.1) {
                map.insert(row.0, value);
            }
        }
        Ok(Value::Object(map))
    }

    pub fn clear(&self, extension_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM extension_storage WHERE extension_id = ?1", params![extension_id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Deletes only the keys under `extension_id` starting with
    /// `key_prefix` — for a Settings-pane action that needs to clear one
    /// logical collection (e.g. T22's translate history) without touching
    /// the rest of that extension's storage (its custom translate pairs).
    /// `%`/`_` in `key_prefix` are escaped so a literal prefix containing
    /// either (unlikely today, but not guaranteed) can't widen the match.
    pub fn clear_matching(&self, extension_id: &str, key_prefix: &str) -> Result<(), String> {
        let escaped = key_prefix.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM extension_storage WHERE extension_id = ?1 AND key LIKE ?2 ESCAPE '\\'",
            params![extension_id, format!("{escaped}%")],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    fn store() -> ExtensionStorage {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE extension_storage (
                extension_id TEXT NOT NULL,
                key TEXT NOT NULL,
                value TEXT NOT NULL,
                PRIMARY KEY (extension_id, key)
            );",
        )
        .unwrap();
        ExtensionStorage::new(Arc::new(Mutex::new(conn)))
    }

    #[test]
    fn values_round_trip_with_their_types() {
        let storage = store();
        storage.set("demo", "s", &json!("42")).unwrap();
        storage.set("demo", "n", &json!(42)).unwrap();
        storage.set("demo", "b", &json!(true)).unwrap();

        assert_eq!(storage.get("demo", "s").unwrap(), json!("42"));
        assert_eq!(storage.get("demo", "n").unwrap(), json!(42));
        assert_eq!(storage.get("demo", "b").unwrap(), json!(true));
    }

    #[test]
    fn missing_keys_read_as_null() {
        let storage = store();
        assert_eq!(storage.get("demo", "absent").unwrap(), Value::Null);
    }

    #[test]
    fn set_overwrites() {
        let storage = store();
        storage.set("demo", "k", &json!(1)).unwrap();
        storage.set("demo", "k", &json!(2)).unwrap();
        assert_eq!(storage.get("demo", "k").unwrap(), json!(2));
    }

    #[test]
    fn extensions_are_isolated_from_each_other() {
        let storage = store();
        storage.set("a", "k", &json!("mine")).unwrap();
        storage.set("b", "k", &json!("theirs")).unwrap();

        assert_eq!(storage.get("a", "k").unwrap(), json!("mine"));
        storage.clear("a").unwrap();
        assert_eq!(storage.get("a", "k").unwrap(), Value::Null);
        // Clearing `a` must not touch `b`.
        assert_eq!(storage.get("b", "k").unwrap(), json!("theirs"));
    }

    #[test]
    fn all_returns_only_the_extensions_own_entries() {
        let storage = store();
        storage.set("a", "x", &json!(1)).unwrap();
        storage.set("a", "y", &json!("two")).unwrap();
        storage.set("b", "z", &json!(3)).unwrap();

        assert_eq!(storage.all("a").unwrap(), json!({ "x": 1, "y": "two" }));
    }

    #[test]
    fn clear_matching_deletes_only_keys_under_the_given_prefix() {
        let storage = store();
        storage.set("translate", "pair:1", &json!("a")).unwrap();
        storage.set("translate", "history:1", &json!("b")).unwrap();
        storage.set("translate", "history:2", &json!("c")).unwrap();
        storage.set("other", "history:1", &json!("d")).unwrap();

        storage.clear_matching("translate", "history:").unwrap();

        assert_eq!(storage.get("translate", "pair:1").unwrap(), json!("a"), "a non-matching key under the same extension must survive");
        assert_eq!(storage.get("translate", "history:1").unwrap(), Value::Null);
        assert_eq!(storage.get("translate", "history:2").unwrap(), Value::Null);
        assert_eq!(storage.get("other", "history:1").unwrap(), json!("d"), "another extension's matching key must be untouched");
    }

    #[test]
    fn remove_deletes_a_single_key() {
        let storage = store();
        storage.set("a", "x", &json!(1)).unwrap();
        storage.set("a", "y", &json!(2)).unwrap();
        storage.remove("a", "x").unwrap();

        assert_eq!(storage.get("a", "x").unwrap(), Value::Null);
        assert_eq!(storage.get("a", "y").unwrap(), json!(2));
    }
}
