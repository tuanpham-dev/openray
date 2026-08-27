use std::collections::hash_map::DefaultHasher;
use std::collections::HashSet;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use arboard::Clipboard;
use rusqlite::params;

use crate::error::Error;
use crate::infrastructure::db::SharedConnection;
use crate::infrastructure::settings::SettingsStore;
use crate::infrastructure::time::now_secs as now_unix;

const POLL_INTERVAL: Duration = Duration::from_millis(700);

/// Images larger than this are skipped rather than copied into history.
/// A screenshot of a 5K display is ~40MB of RGBA; encoding one every poll
/// would cost more than the feature is worth, and a thousand of them would
/// fill the disk. Deliberately not settings-driven, unlike
/// `clipboard_max_entries`/`clipboard_max_image_mb` — this bounds the
/// watcher's own per-poll CPU/memory cost, not something a user has a
/// reason to raise.
const MAX_IMAGE_PIXELS: usize = 40_000_000;

const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff", "tif", "ico", "avif"];

/// `clipboardMaxEntries`/`clipboardMaxImageMb`/`clipboardRetentionDays`,
/// read fresh from `SettingsStore` at the moment each entry is recorded.
#[derive(Clone, Copy)]
struct ClipboardLimits {
    max_entries: i64,
    max_image_bytes: u64,
    /// A `created_at` cutoff (unix seconds) below which an entry is
    /// pruned regardless of `max_entries` — `None` when
    /// `clipboardRetentionDays` is `"never"`. Enforced *alongside*
    /// `max_entries`, not instead of it (the "keep both" decision):
    /// whichever limit is more restrictive prunes further.
    retention_cutoff: Option<i64>,
}

impl ClipboardLimits {
    fn from_settings(settings: &SettingsStore) -> Self {
        let settings = settings.get();
        let retention_cutoff = settings.clipboard_retention_days.parse::<i64>().ok().map(|days| now_unix() - days * 86_400);
        Self {
            max_entries: settings.clipboard_max_entries as i64,
            max_image_bytes: settings.clipboard_max_image_mb as u64 * 1024 * 1024,
            retention_cutoff,
        }
    }
}

pub struct ClipboardWatcher {
    enabled: Arc<AtomicBool>,
    /// Content hashes to record-once-and-forget: see `suppress_text`.
    suppressed: Arc<Mutex<HashSet<u64>>>,
}

impl ClipboardWatcher {
    /// `images_dir` is where captured images are written; `None` disables
    /// image capture (the watcher keeps recording text). `settings` is
    /// read fresh on every recorded entry (not cached at startup), so
    /// `clipboardMaxEntries`/`clipboardMaxImageMb` changes take effect on
    /// the watcher's very next copy — no restart needed.
    pub fn start(conn: SharedConnection, images_dir: Option<PathBuf>, settings: Arc<SettingsStore>) -> Self {
        let enabled = Arc::new(AtomicBool::new(true));
        let watcher_enabled = Arc::clone(&enabled);
        let suppressed: Arc<Mutex<HashSet<u64>>> = Arc::new(Mutex::new(HashSet::new()));
        let watcher_suppressed = Arc::clone(&suppressed);

        thread::spawn(move || {
            let Ok(mut clipboard) = Clipboard::new() else { return };
            let mut last_hash: Option<u64> = None;

            loop {
                thread::sleep(POLL_INTERVAL);

                if !watcher_enabled.load(Ordering::Relaxed) {
                    continue;
                }

                // Text first: it's the cheap read, and an image copied from
                // a browser often carries a text/URL flavour too, which is
                // the more useful thing to keep.
                if let Ok(text) = clipboard.get_text() {
                    if !text.trim().is_empty() {
                        let hash = hash_bytes(text.as_bytes());
                        if last_hash != Some(hash) {
                            last_hash = Some(hash);
                            // A concealed copy is still on the clipboard —
                            // it just must not be written to history.
                            let concealed = watcher_suppressed.lock().unwrap().remove(&hash);
                            if !concealed {
                                let limits = ClipboardLimits::from_settings(&settings);
                                record_copied_text(&conn, &text, hash, images_dir.as_deref(), limits);
                            }
                        }
                        continue;
                    }
                }

                let Some(dir) = images_dir.as_deref() else { continue };
                let Ok(image) = clipboard.get_image() else { continue };

                if image.width * image.height > MAX_IMAGE_PIXELS {
                    continue;
                }

                // Hashing the pixels (not the encoded file) keeps dedupe
                // independent of encoder output, which isn't byte-stable.
                let hash = hash_bytes(&image.bytes);
                if last_hash == Some(hash) {
                    continue;
                }
                last_hash = Some(hash);

                match write_png(dir, hash, &image) {
                    Ok(path) => {
                        let limits = ClipboardLimits::from_settings(&settings);
                        record_image(&conn, &path, image.width as i64, image.height as i64, hash, None, limits)
                    }
                    Err(e) => log::warn!("failed to store clipboard image: {e}"),
                }
            }
        });

        Self { enabled, suppressed }
    }

    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::Relaxed);
    }

    /// Keeps `text` out of clipboard history the next time the watcher
    /// sees it.
    ///
    /// Backs `Clipboard.copy(..., { concealed: true })`, which extensions
    /// use for passwords and tokens: the value belongs on the clipboard
    /// but must not be recorded. Registered by hash so the watcher — which
    /// polls and cannot be told "the copy that is about to happen" — can
    /// recognise it whenever it next reads the clipboard.
    pub fn suppress_text(&self, text: &str) {
        self.suppressed.lock().unwrap().insert(hash_bytes(text.as_bytes()));
    }
}

/// Extracts local file paths from clipboard text produced by a file
/// manager.
///
/// Copying a file in Thunar (or any GTK file manager) doesn't put the
/// file's *contents* on the clipboard — it puts `file://` URIs there,
/// alongside an `x-special/gnome-copied-files` payload whose text flavour
/// is prefixed with a `copy`/`cut` verb line. `get_text()` therefore
/// succeeds and returns a location, which is why such copies used to land
/// in history as ordinary text.
///
/// Returns empty for anything that isn't wholly a path list, so ordinary
/// text starting with `/` isn't mistaken for a file copy.
pub fn parse_clipboard_file_paths(text: &str) -> Vec<PathBuf> {
    let mut paths = Vec::new();

    for line in text.lines() {
        let line = line.trim();
        // The gnome-copied-files verb line, not a path.
        if line.is_empty() || line == "copy" || line == "cut" {
            continue;
        }

        if let Some(rest) = line.strip_prefix("file://") {
            // file:///path has an empty host; anything before the first `/`
            // is a hostname we can't resolve to a local file.
            let Some(path) = rest.find('/').map(|i| &rest[i..]) else { return Vec::new() };
            match urlencoding::decode(path) {
                Ok(decoded) => paths.push(PathBuf::from(decoded.into_owned())),
                Err(_) => return Vec::new(),
            }
        } else if line.starts_with('/') {
            paths.push(PathBuf::from(line));
        } else {
            // A non-path line means this is text that merely contains a
            // path, not a file copy.
            return Vec::new();
        }
    }

    paths
}

fn has_image_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| IMAGE_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn hash_bytes(bytes: &[u8]) -> u64 {
    let mut hasher = DefaultHasher::new();
    bytes.hash(&mut hasher);
    hasher.finish()
}

fn write_png(dir: &Path, hash: u64, image: &arboard::ImageData) -> Result<PathBuf, Error> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join(format!("{hash}.png"));

    // The same content hashes to the same filename, so a re-copy reuses the
    // existing file instead of rewriting it.
    if path.exists() {
        return Ok(path);
    }

    let buffer: image::RgbaImage =
        image::ImageBuffer::from_raw(image.width as u32, image.height as u32, image.bytes.to_vec())
            .ok_or_else(|| Error::msg("clipboard image dimensions don't match its buffer"))?;
    buffer.save_with_format(&path, image::ImageFormat::Png).map_err(|e| Error::msg(e.to_string()))?;
    Ok(path)
}

/// Routes copied text to the right kind of history entry: a file-manager
/// copy becomes a file (or an image, when it points at one) rather than a
/// row showing a `file://` URI.
fn record_copied_text(conn: &SharedConnection, text: &str, hash: u64, images_dir: Option<&Path>, limits: ClipboardLimits) {
    let paths = parse_clipboard_file_paths(text);
    let Some(path) = paths.first().filter(|path| path.is_file()) else {
        record_text(conn, text, hash, limits);
        return;
    };

    let display_path = path.to_string_lossy().into_owned();

    if let (Some(dir), true) = (images_dir, has_image_extension(path)) {
        match preview_copy_of(dir, hash, path, limits.max_image_bytes) {
            Ok((preview, width, height)) => {
                record_image(conn, &preview, width, height, hash, Some(&display_path), limits);
                return;
            }
            Err(e) => log::warn!("failed to build preview for copied image '{display_path}': {e}"),
        }
    }

    record_file(conn, &display_path, hash, limits);
}

/// Decodes a copied image file and writes a PNG copy into the app's own
/// images directory.
///
/// The copy exists so the webview can display it: the asset protocol is
/// scoped to a few directories, and widening it to the whole filesystem to
/// preview a clipboard entry would be a far worse trade than duplicating
/// the odd screenshot. Re-encoding also normalises jpg/webp/gif to one
/// format the preview can rely on.
fn preview_copy_of(dir: &Path, hash: u64, source: &Path, max_image_bytes: u64) -> Result<(PathBuf, i64, i64), Error> {
    let bytes = std::fs::metadata(source)?.len();
    if bytes > max_image_bytes {
        return Err(Error::msg(format!("image file is {bytes} bytes")));
    }

    let decoded = image::open(source).map_err(|e| Error::msg(e.to_string()))?.to_rgba8();
    let (width, height) = decoded.dimensions();
    if width as usize * height as usize > MAX_IMAGE_PIXELS {
        return Err(Error::msg(format!("image is {width}x{height}")));
    }

    std::fs::create_dir_all(dir)?;
    let path = dir.join(format!("{hash}.png"));
    if !path.exists() {
        decoded.save_with_format(&path, image::ImageFormat::Png).map_err(|e| Error::msg(e.to_string()))?;
    }
    Ok((path, width as i64, height as i64))
}

fn record_file(conn: &SharedConnection, path: &str, hash: u64, limits: ClipboardLimits) {
    let now = now_unix();
    let id = format!("clip.{now}.{hash}");

    let conn = conn.lock().unwrap();
    let _ = conn.execute(
        "INSERT INTO clipboard_history (id, content_hash, kind, text_content, created_at)
         VALUES (?1, ?2, 'file', ?3, ?4)
         ON CONFLICT(content_hash) DO UPDATE SET created_at = excluded.created_at",
        params![id, hash.to_string(), path, now],
    );
    trim_history(&conn, limits);
}

fn record_text(conn: &SharedConnection, text: &str, hash: u64, limits: ClipboardLimits) {
    let now = now_unix();
    let id = format!("clip.{now}.{hash}");

    let conn = conn.lock().unwrap();
    let _ = conn.execute(
        "INSERT INTO clipboard_history (id, content_hash, kind, text_content, created_at)
         VALUES (?1, ?2, 'text', ?3, ?4)
         ON CONFLICT(content_hash) DO UPDATE SET created_at = excluded.created_at",
        params![id, hash.to_string(), text, now],
    );
    trim_history(&conn, limits);
}

/// `source` is the originating file path when the image came from a file
/// copy, and `None` when the pixels came straight off the clipboard.
fn record_image(conn: &SharedConnection, path: &Path, width: i64, height: i64, hash: u64, source: Option<&str>, limits: ClipboardLimits) {
    let now = now_unix();
    let id = format!("clip.{now}.{hash}");

    let conn = conn.lock().unwrap();
    let _ = conn.execute(
        "INSERT INTO clipboard_history (id, content_hash, kind, text_content, created_at, image_path, image_width, image_height)
         VALUES (?1, ?2, 'image', ?7, ?3, ?4, ?5, ?6)
         ON CONFLICT(content_hash) DO UPDATE SET created_at = excluded.created_at",
        params![id, hash.to_string(), now, path.to_string_lossy(), width, height, source],
    );
    trim_history(&conn, limits);
}

/// Drops the oldest entries past `limits.max_entries`, and (when
/// `limits.retention_cutoff` is set) anything older than that cutoff
/// regardless of count — the "keep both" limits enforced together,
/// whichever prunes more. Deletes any backing image files first —
/// otherwise the images directory would grow without bound while its rows
/// disappeared.
fn trim_history(conn: &rusqlite::Connection, limits: ClipboardLimits) {
    let stale: Vec<String> = conn
        .prepare(
            "SELECT image_path FROM clipboard_history
             WHERE image_path IS NOT NULL AND (
                id NOT IN (SELECT id FROM clipboard_history ORDER BY created_at DESC LIMIT ?1)
                OR (?2 IS NOT NULL AND created_at < ?2)
             )",
        )
        .and_then(|mut stmt| {
            let rows = stmt.query_map(params![limits.max_entries, limits.retention_cutoff], |row| row.get::<_, String>(0))?;
            Ok(rows.filter_map(Result::ok).collect())
        })
        .unwrap_or_default();

    let _ = conn.execute(
        "DELETE FROM clipboard_history WHERE
            id NOT IN (SELECT id FROM clipboard_history ORDER BY created_at DESC LIMIT ?1)
            OR (?2 IS NOT NULL AND created_at < ?2)",
        params![limits.max_entries, limits.retention_cutoff],
    );

    for path in stale {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn conn_with_clipboard_table() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE clipboard_history (
                id TEXT PRIMARY KEY,
                content_hash TEXT NOT NULL UNIQUE,
                kind TEXT NOT NULL,
                text_content TEXT,
                created_at INTEGER NOT NULL,
                image_path TEXT,
                image_width INTEGER,
                image_height INTEGER
            )",
        )
        .unwrap();
        conn
    }

    fn insert_row(conn: &Connection, id: &str, created_at: i64) {
        conn.execute(
            "INSERT INTO clipboard_history (id, content_hash, kind, text_content, created_at) VALUES (?1, ?1, 'text', ?1, ?2)",
            params![id, created_at],
        )
        .unwrap();
    }

    fn row_ids(conn: &Connection) -> Vec<String> {
        let mut stmt = conn.prepare("SELECT id FROM clipboard_history ORDER BY created_at").unwrap();
        stmt.query_map([], |r| r.get::<_, String>(0)).unwrap().filter_map(Result::ok).collect()
    }

    #[test]
    fn trim_history_prunes_by_retention_cutoff_alongside_max_entries() {
        let conn = conn_with_clipboard_table();
        let now = now_unix();
        insert_row(&conn, "old", now - 10 * 86_400);
        insert_row(&conn, "recent", now - 86_400);

        // A generous max_entries (both rows fit) but a 5-day retention
        // cutoff prunes the 10-day-old row while keeping the 1-day-old one.
        let limits = ClipboardLimits { max_entries: 100, max_image_bytes: u64::MAX, retention_cutoff: Some(now - 5 * 86_400) };
        trim_history(&conn, limits);

        assert_eq!(row_ids(&conn), vec!["recent".to_string()]);
    }

    #[test]
    fn trim_history_with_no_retention_cutoff_only_enforces_max_entries() {
        let conn = conn_with_clipboard_table();
        let now = now_unix();
        insert_row(&conn, "oldest", now - 100 * 86_400);
        insert_row(&conn, "recent", now - 86_400);

        // "never" (retention_cutoff: None): today's behavior, count-only.
        let limits = ClipboardLimits { max_entries: 1, max_image_bytes: u64::MAX, retention_cutoff: None };
        trim_history(&conn, limits);

        assert_eq!(row_ids(&conn), vec!["recent".to_string()]);
    }

    #[test]
    fn parses_a_gtk_file_manager_copy() {
        // What Thunar puts on the clipboard: a verb line then file URIs.
        let paths = parse_clipboard_file_paths("copy\nfile:///home/user/Pictures/shot.png");
        assert_eq!(paths, vec![PathBuf::from("/home/user/Pictures/shot.png")]);
    }

    #[test]
    fn percent_decodes_uris() {
        let paths = parse_clipboard_file_paths("file:///home/user/My%20Photos/a%2Bb.png");
        assert_eq!(paths, vec![PathBuf::from("/home/user/My Photos/a+b.png")]);
    }

    #[test]
    fn parses_multiple_files_and_bare_paths() {
        let paths = parse_clipboard_file_paths("file:///tmp/a.png\n/tmp/b.png");
        assert_eq!(paths, vec![PathBuf::from("/tmp/a.png"), PathBuf::from("/tmp/b.png")]);
    }

    #[test]
    fn ordinary_text_is_not_a_file_copy() {
        assert!(parse_clipboard_file_paths("just some copied words").is_empty());
        // Mentions a path but isn't one, so it stays text.
        assert!(parse_clipboard_file_paths("see /etc/hosts for details").is_empty());
        assert!(parse_clipboard_file_paths("https://example.com/a.png").is_empty());
    }

    #[test]
    fn a_path_line_mixed_with_prose_is_not_a_file_copy() {
        assert!(parse_clipboard_file_paths("/tmp/a.png\nand some notes").is_empty());
    }

    #[test]
    fn recognises_image_extensions_case_insensitively() {
        assert!(has_image_extension(Path::new("/tmp/a.PNG")));
        assert!(has_image_extension(Path::new("/tmp/a.jpeg")));
        assert!(!has_image_extension(Path::new("/tmp/a.pdf")));
        assert!(!has_image_extension(Path::new("/tmp/noext")));
    }
}
