//! File Search: fuzzy filename search over user-configured scopes.
//!
//! Modeled directly on `application::screenshots` — a native provider
//! backing a `root-provider` extension, an SQLite-cached index kept fresh
//! by a background sweep, and the same "no scopes → no rows" precedent.
//! The one real architectural difference: Screenshots' scan (`read_dir`
//! over a couple of known folders) is cheap enough to run live on every
//! `list()` call, so only its *content processing* (OCR/thumbnails) is a
//! separately-capped background step. File Search scopes are unbounded
//! (plausibly a whole home directory), so the walk itself — not a
//! downstream step — is the expensive part: `query()` never walks the
//! filesystem, it only reads the SQLite index the background sweep
//! (`spawn_index_sweep`) maintains. A scope's first sweep after being
//! configured is the expensive one; subsequent sweeps skip any file whose
//! mtime hasn't changed, so steady-state sweeps stay cheap.
//!
//! Filename search only — content/grep search is explicitly out of scope
//! for this pass (see `plans/file-search-ai-memory-retention.md`).

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use ignore::WalkBuilder;
use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher};
use rusqlite::params;
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::infrastructure::db::SharedConnection;
use crate::infrastructure::paths::expand_home;
use crate::infrastructure::platform::background_priority;
use crate::infrastructure::time::now_secs as now_unix;

/// Same reasoning as Screenshots' own `CACHE_TTL` — absorbs a query
/// view's per-keystroke refetch of the index without hitting SQLite on
/// every character typed.
const CACHE_TTL: Duration = Duration::from_secs(3);
const MAX_RESULTS: usize = 200;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    pub name: String,
}

type ResultCache = Arc<RwLock<Option<(Instant, Vec<FileEntry>)>>>;

pub struct FileSearchProvider {
    app: AppHandle,
    conn: SharedConnection,
    cache: ResultCache,
    /// Single-flight guard for `spawn_index_sweep`, same reasoning as
    /// `ScreenshotsProvider::indexing`.
    indexing: Arc<AtomicBool>,
}

impl FileSearchProvider {
    pub fn new(app: AppHandle, conn: SharedConnection) -> Self {
        Self { app, conn, cache: Arc::new(RwLock::new(None)), indexing: Arc::new(AtomicBool::new(false)) }
    }

    fn settings(&self) -> crate::infrastructure::settings::Settings {
        self.app
            .try_state::<crate::application::state::AppState>()
            .map(|state| state.settings.get())
            .unwrap_or_default()
    }

    fn indexed_entries(&self) -> Vec<FileEntry> {
        if let Some((fetched_at, entries)) = self.cache.read().unwrap().as_ref() {
            if fetched_at.elapsed() < CACHE_TTL {
                return entries.clone();
            }
        }
        let entries = read_index(&self.conn.lock().unwrap()).unwrap_or_default();
        *self.cache.write().unwrap() = Some((Instant::now(), entries.clone()));
        entries
    }

    /// Fuzzy-matches `query` against the SQLite-cached index. Never walks
    /// the filesystem itself — empty until `spawn_index_sweep` has
    /// completed at least once for the configured scopes, the same
    /// eventual-indexing tradeoff Screenshots' OCR text search already
    /// makes.
    pub fn query(&self, query: &str) -> Vec<FileEntry> {
        let entries = self.indexed_entries();
        let trimmed = query.trim();
        if trimmed.is_empty() {
            return entries.into_iter().take(MAX_RESULTS).collect();
        }

        let mut matcher = Matcher::new(Config::DEFAULT);
        let pattern = Pattern::parse(trimmed, CaseMatching::Ignore, Normalization::Smart);
        let mut scored: Vec<(u32, FileEntry)> = entries
            .into_iter()
            .filter_map(|entry| {
                let mut buf = Vec::new();
                let haystack = nucleo_matcher::Utf32Str::new(&entry.name, &mut buf);
                let score = pattern.score(haystack, &mut matcher)?;
                Some((score, entry))
            })
            .collect();
        scored.sort_by_key(|(score, _)| std::cmp::Reverse(*score));
        scored.into_iter().take(MAX_RESULTS).map(|(_, entry)| entry).collect()
    }

    /// Kicks a background walk of every configured scope if one isn't
    /// already running. Fire-and-forget: results show up on the next
    /// `query()` call once the walk commits rows to `file_search_index`
    /// and this invalidates the result cache.
    pub fn spawn_index_sweep(&self) {
        let scopes = self.settings().file_search_scopes;
        if scopes.is_empty() {
            return;
        }
        if self.indexing.swap(true, Ordering::SeqCst) {
            return;
        }

        let conn = self.conn.clone();
        let cache = self.cache.clone();
        let indexing = self.indexing.clone();

        std::thread::spawn(move || {
            // Same reasoning as Screenshots' sweep thread — real CPU/IO
            // work (a recursive directory walk) that shouldn't compete
            // evenly with the UI thread.
            background_priority::lower_current_thread_priority();
            run_index_sweep(&conn, &scopes);
            *cache.write().unwrap() = None;
            indexing.store(false, Ordering::SeqCst);
        });
    }
}

fn read_index(conn: &rusqlite::Connection) -> rusqlite::Result<Vec<FileEntry>> {
    let mut stmt = conn.prepare("SELECT path, name FROM file_search_index ORDER BY name")?;
    let rows = stmt.query_map([], |row| Ok(FileEntry { path: row.get(0)?, name: row.get(1)? }))?;
    rows.collect()
}

fn indexed_mtimes(conn: &rusqlite::Connection) -> rusqlite::Result<HashMap<String, i64>> {
    let mut stmt = conn.prepare("SELECT path, mtime FROM file_search_index")?;
    let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))?;
    rows.collect()
}

fn indexed_paths(conn: &rusqlite::Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT path FROM file_search_index")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    rows.collect()
}

/// Files present in `indexed_paths` but not in `live_paths` — same
/// function shape as `screenshots::paths_to_prune`.
fn paths_to_prune(indexed_paths: &[String], live_paths: &HashSet<String>) -> Vec<String> {
    indexed_paths.iter().filter(|path| !live_paths.contains(path.as_str())).cloned().collect()
}

fn upsert_file_row(conn: &rusqlite::Connection, path: &str, name: &str, mtime: i64, indexed_at: i64) {
    let _ = conn.execute(
        "INSERT INTO file_search_index (path, name, mtime, indexed_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(path) DO UPDATE SET name = excluded.name, mtime = excluded.mtime, indexed_at = excluded.indexed_at",
        params![path, name, mtime, indexed_at],
    );
}

fn mtime_secs(entry: &ignore::DirEntry) -> i64 {
    entry
        .metadata()
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Walks every configured scope (respecting `.gitignore`/`.ignore`/global
/// git excludes — the `ignore` crate's default behavior, the same crate
/// ripgrep/fd use internally), upserting new/changed files by mtime and
/// pruning rows whose path no longer exists. The walk itself is not
/// capped (see this module's doc comment for why that's safe here but
/// wouldn't be for Screenshots' `MAX_SWEEP_IMAGES`-style content-processing
/// cap): only files whose mtime actually changed since the last sweep incur
/// a write, so a steady-state sweep over an unchanged tree is a stat-only
/// pass, not a re-index.
fn run_index_sweep(conn: &SharedConnection, scopes: &[String]) {
    let existing_mtimes = indexed_mtimes(&conn.lock().unwrap()).unwrap_or_default();
    let mut live_paths: HashSet<String> = HashSet::new();
    let now = now_unix();

    for scope in scopes {
        let root = expand_home(scope);
        for result in WalkBuilder::new(&root).build() {
            let Ok(dir_entry) = result else { continue };
            if !dir_entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                continue;
            }
            let Some(path) = dir_entry.path().to_str().map(String::from) else { continue };
            let Some(name) = dir_entry.file_name().to_str().map(String::from) else { continue };

            let mtime = mtime_secs(&dir_entry);
            live_paths.insert(path.clone());

            if existing_mtimes.get(&path).copied() == Some(mtime) {
                continue;
            }
            upsert_file_row(&conn.lock().unwrap(), &path, &name, mtime, now);
        }
    }

    let existing_paths = indexed_paths(&conn.lock().unwrap()).unwrap_or_default();
    for path in paths_to_prune(&existing_paths, &live_paths) {
        let _ = conn.lock().unwrap().execute("DELETE FROM file_search_index WHERE path = ?1", params![path]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn conn_with_index_table() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE file_search_index (path TEXT PRIMARY KEY, name TEXT NOT NULL, mtime INTEGER NOT NULL, indexed_at INTEGER NOT NULL)",
        )
        .unwrap();
        conn
    }

    #[test]
    fn paths_to_prune_removes_only_vanished_paths() {
        let indexed = vec!["/a.rs".to_string(), "/b.rs".to_string(), "/c.rs".to_string()];
        let live: HashSet<String> = ["/a.rs".to_string(), "/c.rs".to_string()].into_iter().collect();
        assert_eq!(paths_to_prune(&indexed, &live), vec!["/b.rs".to_string()]);
    }

    #[test]
    fn upsert_file_row_inserts_then_overwrites_on_conflict() {
        let conn = conn_with_index_table();
        upsert_file_row(&conn, "/a.rs", "a.rs", 100, 1000);
        upsert_file_row(&conn, "/a.rs", "a.rs", 200, 2000);

        let (mtime, indexed_at): (i64, i64) =
            conn.query_row("SELECT mtime, indexed_at FROM file_search_index WHERE path = '/a.rs'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!(mtime, 200);
        assert_eq!(indexed_at, 2000);
    }

    #[test]
    fn run_index_sweep_walks_a_scope_respects_gitignore_and_prunes_deleted_files() {
        let dir = tempdir();
        fs::write(dir.join("keep.rs"), "fn main() {}").unwrap();
        fs::write(dir.join("ignored.rs"), "fn main() {}").unwrap();
        fs::write(dir.join(".gitignore"), "ignored.rs\n").unwrap();
        fs::create_dir(dir.join(".git")).unwrap(); // makes this a real git root for gitignore to apply

        let conn = shared(conn_with_index_table());
        run_index_sweep(&conn, &[dir.to_str().unwrap().to_string()]);

        let names: HashSet<String> = {
            let c = conn.lock().unwrap();
            let mut stmt = c.prepare("SELECT name FROM file_search_index").unwrap();
            stmt.query_map([], |r| r.get::<_, String>(0)).unwrap().filter_map(Result::ok).collect()
        };
        assert!(names.contains("keep.rs"));
        assert!(!names.contains("ignored.rs"), "gitignored file should not be indexed");

        // Delete the kept file and re-sweep — its row should be pruned.
        fs::remove_file(dir.join("keep.rs")).unwrap();
        run_index_sweep(&conn, &[dir.to_str().unwrap().to_string()]);
        let count: i64 = conn.lock().unwrap().query_row("SELECT COUNT(*) FROM file_search_index", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 0);

        fs::remove_dir_all(&dir).unwrap();
    }

    fn shared(conn: rusqlite::Connection) -> SharedConnection {
        Arc::new(std::sync::Mutex::new(conn))
    }

    fn tempdir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("openray-file-search-test-{}-{}", std::process::id(), now_unix()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }
}
