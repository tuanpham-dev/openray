//! The registries a user has chosen to install extensions from.
//!
//! A registry is nothing but a base URL (or a local directory) serving an
//! `index.json` catalog and one archive per extension — there is no server
//! side to any of this, which is what lets anyone publish one from a static
//! host. That also means adding a source *is* the trust decision: an
//! archive is unsigned code that runs in the extension host with the
//! user's own privileges, so the UI confirms on add, records where every
//! installed extension came from, and keeps auto-update switchable per
//! source.

use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::error::Error;
use crate::infrastructure::db::SharedConnection;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RegistrySource {
    /// Base URL or directory path. Normalized to end in `/` so joining a
    /// catalog's relative entry paths is unambiguous.
    pub url: String,
    /// The catalog's own declared name, captured when the source was added.
    pub name: Option<String>,
    pub enabled: bool,
    pub auto_update: bool,
    pub added_at: i64,
}

/// Trailing-slash normalization, applied on the way in and on every lookup.
///
/// Without it `https://x.test/registry` and `https://x.test/registry/` are
/// two rows for one registry, and — worse — the same extension installed
/// from "both" would compare unequal on `source_url`, which is what decides
/// whether an update is same-source (silent) or cross-source (confirmed).
pub fn normalize_url(url: &str) -> String {
    let trimmed = url.trim();
    if trimmed.ends_with('/') {
        trimmed.to_string()
    } else {
        format!("{trimmed}/")
    }
}

pub struct RegistrySources {
    conn: SharedConnection,
}

impl RegistrySources {
    pub fn new(conn: SharedConnection) -> Self {
        Self { conn }
    }

    pub fn list(&self) -> Vec<RegistrySource> {
        let conn = self.conn.lock().unwrap();
        let Ok(mut stmt) =
            conn.prepare("SELECT url, name, enabled, auto_update, added_at FROM registry_sources ORDER BY added_at")
        else {
            return Vec::new();
        };
        let rows = stmt.query_map([], |row| {
            Ok(RegistrySource {
                url: row.get(0)?,
                name: row.get(1)?,
                enabled: row.get::<_, i64>(2)? != 0,
                auto_update: row.get::<_, i64>(3)? != 0,
                added_at: row.get(4)?,
            })
        });
        match rows {
            Ok(rows) => rows.filter_map(Result::ok).collect(),
            Err(_) => Vec::new(),
        }
    }

    pub fn enabled(&self) -> Vec<RegistrySource> {
        self.list().into_iter().filter(|source| source.enabled).collect()
    }

    pub fn get(&self, url: &str) -> Option<RegistrySource> {
        let url = normalize_url(url);
        self.list().into_iter().find(|source| source.url == url)
    }

    /// Adds a source, or updates the name of one already present. Callers
    /// validate the catalog *before* this — a URL that doesn't serve a
    /// readable `index.json` should never become a stored source.
    pub fn add(&self, url: &str, name: Option<&str>, added_at: i64) -> Result<RegistrySource, Error> {
        let url = normalize_url(url);
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO registry_sources (url, name, enabled, auto_update, added_at)
             VALUES (?1, ?2, 1, 1, ?3)
             ON CONFLICT(url) DO UPDATE SET name = COALESCE(?2, name)",
            params![url, name, added_at],
        )?;
        drop(conn);
        self.get(&url).ok_or_else(|| Error::msg("registry source vanished after insert"))
    }

    pub fn remove(&self, url: &str) -> Result<(), Error> {
        let url = normalize_url(url);
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM registry_sources WHERE url = ?1", params![url])?;
        Ok(())
    }

    pub fn set_enabled(&self, url: &str, enabled: bool) -> Result<(), Error> {
        let url = normalize_url(url);
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE registry_sources SET enabled = ?1 WHERE url = ?2",
            params![enabled as i64, url],
        )?;
        Ok(())
    }

    pub fn set_auto_update(&self, url: &str, auto_update: bool) -> Result<(), Error> {
        let url = normalize_url(url);
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE registry_sources SET auto_update = ?1 WHERE url = ?2",
            params![auto_update as i64, url],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use std::sync::{Arc, Mutex};

    fn store() -> RegistrySources {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../../migrations/0033_registry_sources.sql")).unwrap();
        RegistrySources::new(Arc::new(Mutex::new(conn)))
    }

    #[test]
    fn normalizes_a_missing_trailing_slash() {
        assert_eq!(normalize_url("https://x.test/registry"), "https://x.test/registry/");
        assert_eq!(normalize_url("https://x.test/registry/"), "https://x.test/registry/");
        assert_eq!(normalize_url("  https://x.test/r  "), "https://x.test/r/");
    }

    #[test]
    fn adding_the_same_registry_twice_is_one_source() {
        // The two spellings must not become two rows: `source_url` is what
        // decides whether an update is same-source or a cross-source
        // replacement, and that comparison is exact.
        let store = store();
        store.add("https://x.test/registry", Some("First"), 1).unwrap();
        store.add("https://x.test/registry/", None, 2).unwrap();

        let sources = store.list();
        assert_eq!(sources.len(), 1);
        // A re-add with no name keeps the one already recorded.
        assert_eq!(sources[0].name.as_deref(), Some("First"));
        assert!(sources[0].enabled);
        assert!(sources[0].auto_update);
    }

    #[test]
    fn toggles_are_independent_and_survive_lookup_by_either_spelling() {
        let store = store();
        store.add("https://x.test/r/", Some("R"), 1).unwrap();

        store.set_auto_update("https://x.test/r", false).unwrap();
        let source = store.get("https://x.test/r").unwrap();
        assert!(source.enabled, "disabling auto-update must not disable the source");
        assert!(!source.auto_update);

        store.set_enabled("https://x.test/r/", false).unwrap();
        assert!(store.enabled().is_empty());
        assert_eq!(store.list().len(), 1, "a disabled source is still listed");
    }

    #[test]
    fn removes_by_either_spelling() {
        let store = store();
        store.add("https://x.test/r/", None, 1).unwrap();
        store.remove("https://x.test/r").unwrap();
        assert!(store.list().is_empty());
    }
}
