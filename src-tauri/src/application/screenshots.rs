use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime};

use rusqlite::params;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::application::extension_bridge::EXTENSION_TOAST_EVENT;
use crate::domain::ports::{PasteInjector, Trash as TrashPort};
use crate::infrastructure::db::SharedConnection;
use crate::infrastructure::paths::expand_home;
use crate::infrastructure::time::{now_secs as now_unix, to_unix_secs, EPOCH};
use crate::infrastructure::trash::SystemTrash;
use crate::infrastructure::{platform, video_thumbs};

/// How often the storage-duration trash sweep is allowed to run, at most —
/// "once a day" per the setting's own framing, enforced opportunistically
/// (this codebase has no scheduler) via `last_trash_sweep_at`.
const TRASH_SWEEP_INTERVAL_SECS: i64 = 86_400;

const OCR_UPDATED_EVENT: &str = "screenshots-ocr-updated";
/// Bounds a single sweep's worst case (a huge, never-indexed folder) —
/// older files resume on the next sweep via the ordinary staleness check,
/// no extra bookkeeping needed to remember where a capped sweep left off.
const MAX_SWEEP_IMAGES: usize = 500;
/// How many freshly-indexed rows accumulate before the sweep tells the
/// open view to refetch — frequent enough that text search fills in
/// progressively, not so frequent that a big folder spams events.
const SWEEP_EMIT_BATCH: usize = 5;
/// Same reasoning as `MAX_SWEEP_IMAGES`, sized smaller since video
/// folders are typically much smaller than screenshot folders.
const MAX_SWEEP_VIDEO_THUMBS: usize = 200;

const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp"];

/// A short-lived cache, the same shape any builtin provider whose
/// `commands()` hits the filesystem needs (`commands()` runs on every
/// keystroke) — long enough to absorb the palette's own re-renders of
/// one search session, short enough that a screenshot taken
/// moments ago shows up on the next fresh search.
const CACHE_TTL: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaEntry {
    pub path: String,
    pub name: String,
    /// Creation time where the filesystem reports one (macOS/Windows
    /// birthtime, Linux `statx` on ext4/btrfs/xfs), falling back to
    /// modification time where it doesn't. This is what search and the
    /// grid sort by.
    pub created_at: i64,
    /// Kept separate from `created_at` because OCR staleness (added in a
    /// later phase) must key off *content* changes, which only
    /// modification time reflects — an in-place edit doesn't change
    /// creation time.
    pub modified_at: i64,
    /// `"image"` or `"video"`.
    pub kind: String,
    pub ocr_text: Option<String>,
    /// A cached preview-frame JPEG for a video entry, filled in by
    /// `run_index_sweep`'s thumbnail pass — `None` for images (which the
    /// grid renders straight from `path`) and for a video that hasn't
    /// been swept yet, has no thumbnail tool available, or whose
    /// extraction failed.
    pub thumbnail_path: Option<String>,
    /// Present in the `screenshot_pins` table — exempts this entry from
    /// the storage-duration trash sweep (`trash_expired_entries`).
    /// Defaults to `false` at construction (`scan_scopes`); the real value
    /// is joined in from that table by `list()`, same shape as
    /// `ocr_text`/`thumbnail_path`.
    pub pinned: bool,
}

fn unix_secs(time: std::io::Result<SystemTime>) -> Option<i64> {
    to_unix_secs(time.ok()?)
}

fn classify_extension(ext: &str, video_extensions: &[String]) -> Option<&'static str> {
    let lower = ext.to_lowercase();
    if IMAGE_EXTENSIONS.contains(&lower.as_str()) {
        Some("image")
    } else if video_extensions.iter().any(|candidate| candidate.eq_ignore_ascii_case(&lower)) {
        Some("video")
    } else {
        None
    }
}

fn resolve_created_at(created: Option<i64>, modified_at: i64) -> i64 {
    created.unwrap_or(modified_at)
}

fn scan_scopes(scopes: &[String], video_extensions: &[String]) -> Vec<MediaEntry> {
    // Sorted on the raw `SystemTime`, not the truncated-to-seconds
    // `created_at` field: a burst of screenshots (or this function's own
    // test fixtures) can land multiple files in the same second, and
    // sorting on the already-truncated value would leave those tied,
    // falling back to arbitrary directory scan order instead of real
    // creation order.
    let mut raw: Vec<(SystemTime, MediaEntry)> = Vec::new();
    for scope in scopes {
        let Ok(dir_entries) = std::fs::read_dir(expand_home(scope)) else { continue };
        for dir_entry in dir_entries.flatten() {
            let path = dir_entry.path();
            if path.is_dir() {
                continue;
            }
            let Some(ext) = path.extension().and_then(|e| e.to_str()) else { continue };
            let Some(kind) = classify_extension(ext, video_extensions) else { continue };
            let Some(name) = path.file_name().and_then(|n| n.to_str()).map(String::from) else { continue };
            let Some(path_str) = path.to_str().map(String::from) else { continue };
            let Ok(metadata) = dir_entry.metadata() else { continue };
            let modified_time = metadata.modified().unwrap_or(EPOCH);
            let created_time = metadata.created().unwrap_or(modified_time);
            let modified_at = unix_secs(Ok(modified_time)).unwrap_or(0);
            let created_at = resolve_created_at(unix_secs(Ok(created_time)), modified_at);
            raw.push((
                created_time,
                MediaEntry { path: path_str, name, created_at, modified_at, kind: kind.into(), ocr_text: None, thumbnail_path: None, pinned: false },
            ));
        }
    }
    raw.sort_by_key(|(created_time, _)| std::cmp::Reverse(*created_time));
    raw.into_iter().map(|(_, entry)| entry).collect()
}

type ScanCache = Arc<RwLock<Option<(Instant, Vec<MediaEntry>)>>>;

pub struct ScreenshotsProvider {
    app: AppHandle,
    paste_injector: Box<dyn PasteInjector>,
    conn: SharedConnection,
    // `Arc` so the background sweep (on its own thread) can invalidate it
    // directly — see the comment on `run_index_sweep`'s cache param for
    // why that matters.
    cache: ScanCache,
    /// Single-flight guard for `spawn_index_sweep` — an open Search
    /// Screenshots view calls `list_screenshots` repeatedly (every
    /// keystroke's refetch, the cache-TTL boundary, …), and only one
    /// background sweep should ever be in flight at a time.
    indexing: Arc<AtomicBool>,
    /// When the storage-duration trash sweep last ran — `None` until the
    /// first opportunistic run. See `TRASH_SWEEP_INTERVAL_SECS`.
    last_trash_sweep_at: Arc<Mutex<Option<i64>>>,
}

impl ScreenshotsProvider {
    pub fn new(app: AppHandle, conn: SharedConnection, paste_injector: Box<dyn PasteInjector>) -> Self {
        Self {
            app,
            paste_injector,
            conn,
            cache: Arc::new(RwLock::new(None)),
            indexing: Arc::new(AtomicBool::new(false)),
            last_trash_sweep_at: Arc::new(Mutex::new(None)),
        }
    }

    fn trash_sweep_due(&self) -> bool {
        match *self.last_trash_sweep_at.lock().unwrap() {
            None => true,
            Some(at) => now_unix() - at >= TRASH_SWEEP_INTERVAL_SECS,
        }
    }

    fn settings(&self) -> crate::infrastructure::settings::Settings {
        self.app
            .try_state::<crate::application::state::AppState>()
            .map(|state| state.settings.get())
            .unwrap_or_default()
    }

    /// Scans every configured scope, newest-first, left-joined against
    /// whatever OCR text and video thumbnails `spawn_index_sweep` has
    /// indexed so far.
    pub fn list(&self) -> Vec<MediaEntry> {
        if let Some((fetched_at, entries)) = self.cache.read().unwrap().as_ref() {
            if fetched_at.elapsed() < CACHE_TTL {
                return entries.clone();
            }
        }

        let settings = self.settings();
        for scope in &settings.screenshot_search_scopes {
            // Required for `convertFileSrc` to serve thumbnails from a
            // user-configured folder outside `tauri.conf.json`'s static
            // asset scope.
            let _ = self.app.asset_protocol_scope().allow_directory(expand_home(scope), true);
        }

        let mut entries = scan_scopes(&settings.screenshot_search_scopes, &settings.screenshot_video_extensions);
        let ocr_texts = indexed_texts(&self.conn.lock().unwrap()).unwrap_or_default();
        let thumbs = indexed_thumbs(&self.conn.lock().unwrap()).unwrap_or_default();
        let pins = pinned_paths(&self.conn.lock().unwrap()).unwrap_or_default();
        let dir = thumbs_dir(&self.app);
        for entry in &mut entries {
            entry.ocr_text = ocr_texts.get(&entry.path).cloned();
            entry.thumbnail_path = thumbs
                .get(&entry.path)
                .filter(|thumb| !thumb.is_empty())
                .zip(dir.as_ref())
                .and_then(|(thumb, dir)| dir.join(thumb).to_str().map(String::from));
            entry.pinned = pins.contains(&entry.path);
        }

        *self.cache.write().unwrap() = Some((Instant::now(), entries.clone()));
        entries
    }

    /// Toggles whether `path` is exempt from the storage-duration trash
    /// sweep (`trash_expired_entries`). Invalidates the scan cache so the
    /// next `list()` reflects the change immediately rather than waiting
    /// out `CACHE_TTL`.
    pub fn set_pinned(&self, path: &str, pinned: bool) {
        {
            let conn = self.conn.lock().unwrap();
            if pinned {
                let _ = conn.execute(
                    "INSERT INTO screenshot_pins (path, pinned_at) VALUES (?1, ?2) ON CONFLICT(path) DO NOTHING",
                    params![path, now_unix()],
                );
            } else {
                let _ = conn.execute("DELETE FROM screenshot_pins WHERE path = ?1", params![path]);
            }
        }
        *self.cache.write().unwrap() = None;
    }

    /// Kicks a background index sweep (OCR text, video thumbnails) if one
    /// isn't already running and at least one of the two is actually
    /// usable right now. Fire-and-forget: callers (the `list_screenshots`
    /// API handler) don't wait on it — results show up via the next
    /// `list()` call once `screenshots-ocr-updated` fires.
    pub fn spawn_index_sweep(&self) {
        let settings = self.settings();
        let ocr_active = settings.screenshot_ocr_enabled && platform::ocr::available();
        let thumbs_active = video_thumbs::available();
        let storage_duration = settings.screenshot_storage_duration;
        let trash_active = storage_duration != "unlimited" && self.trash_sweep_due();
        if !ocr_active && !thumbs_active && !trash_active {
            return;
        }
        if self.indexing.swap(true, Ordering::SeqCst) {
            return;
        }
        // Marked "done" before the thread actually runs, not after — the
        // `indexing` single-flight guard above already prevents a second
        // sweep from starting concurrently, and this keeps the "due" check
        // simple (no separate in-flight state to track).
        if trash_active {
            *self.last_trash_sweep_at.lock().unwrap() = Some(now_unix());
        }

        let conn = self.conn.clone();
        let app = self.app.clone();
        let cache = self.cache.clone();
        let entries = self.list();
        let indexing = self.indexing.clone();
        let dir = thumbs_dir(&self.app);

        std::thread::spawn(move || {
            // A guard, not a plain `store(false, ..)` at the end — a panic
            // partway through (a bad thumbnail, say) would otherwise skip
            // that final line and leave `indexing` stuck `true` forever,
            // permanently turning `spawn_index_sweep` into a silent no-op
            // for the rest of the process's life. Found live: `extract_text`
            // itself has no timeout on the underlying platform call, so a
            // *hang* (not just a panic) here was possible before the OCR
            // rewrite that stopped Vision from touching the file directly —
            // this guard is the other half of that fix, for panics the
            // rewrite doesn't cover.
            struct ResetIndexingOnDrop(Arc<AtomicBool>);
            impl Drop for ResetIndexingOnDrop {
                fn drop(&mut self) {
                    self.0.store(false, Ordering::SeqCst);
                }
            }
            let _reset_indexing = ResetIndexingOnDrop(indexing);

            // Lower this thread's scheduling priority first — the sweep
            // does real CPU work (in-process image decode for OCR, plus
            // any `tesseract`/`ffmpeg` subprocesses it spawns, which
            // inherit this niceness across fork/exec) and shouldn't
            // compete evenly with the UI thread if the user interacts
            // with the app while it's still running. See
            // `platform::background_priority`.
            platform::background_priority::lower_current_thread_priority();
            run_index_sweep(&conn, &app, &cache, &entries, ocr_active, thumbs_active, dir.as_deref());
            if trash_active {
                trash_expired_entries(&entries, &storage_duration);
            }
        });
    }

    pub fn find_latest_image(&self) -> Option<MediaEntry> {
        self.list().into_iter().find(|entry| entry.kind == "image")
    }

    /// Copies+pastes using the configured default format (`screenshot_paste_format`).
    pub fn paste_path(&self, path: &str) -> Result<(), String> {
        self.paste_path_as(path, &self.settings().screenshot_paste_format)
    }

    /// Copies+pastes using an explicit format — the grid's per-format
    /// action-panel entries ("Paste as Image"/"Paste as File"/"Paste as
    /// Path") override the setting this way rather than through it.
    pub fn paste_path_as(&self, path: &str, format: &str) -> Result<(), String> {
        self.copy_path_as(path, format)?;
        self.paste_injector.paste_current_clipboard()?;
        Ok(())
    }

    /// Delivers `path` to whatever window is under the mouse pointer as a
    /// synthesized OS-level drag-and-drop drop — see
    /// `platform::drop_at_cursor`. Toasts and returns the error rather
    /// than silently failing, since (unlike Paste's clipboard fallback
    /// ladder) there's no degraded-but-useful outcome for a drop that
    /// found no target or timed out.
    pub fn drop_path_at_cursor(&self, path: &str) -> Result<(), String> {
        platform::drop_at_cursor::drop_file_at_cursor(std::path::Path::new(path)).inspect_err(|e| {
            self.toast("Drop Screenshot", e);
        })
    }

    /// Puts `path` on the clipboard as one of three representations:
    /// - `"image"` — decoded pixel data (`image/png` on X11), what most
    ///   chat/editor paste targets expect.
    /// - `"file"` — a `text/uri-list` file reference (arboard's
    ///   `file_list`), what file-manager-style paste targets and some
    ///   upload dropzones' paste handlers expect — works for videos too,
    ///   since no image decode is involved.
    /// - `"path"` — the plain path string, for targets that just want
    ///   text (a terminal, an address bar, …).
    /// - `"auto"` — image pixels, a file reference, *and* the plain path
    ///   all offered on the clipboard at once (see
    ///   `platform::clipboard_multi`), so whichever a paste target asks
    ///   for, it gets something useful — matching how copying a file in
    ///   a file manager and pasting into a plain-text editor shows the
    ///   path. Falls back to `"file"` (or, if the *only* problem was an
    ///   oversized entry, `"image"`) on any backend failure — Wayland
    ///   until a native backend lands, a claim that timed out, anything.
    ///
    /// Anything else falls back to `"image"`.
    pub fn copy_path_as(&self, path: &str, format: &str) -> Result<(), String> {
        match format {
            "auto" => self.copy_path_auto(path),
            "file" => {
                let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
                clipboard.set().file_list(&[path]).map_err(|e| e.to_string())
            }
            "path" => {
                let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
                clipboard.set_text(path).map_err(|e| e.to_string())
            }
            _ => {
                let decoded = image::open(path).map_err(|e| e.to_string())?.to_rgba8();
                let (width, height) = decoded.dimensions();
                let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
                clipboard
                    .set_image(arboard::ImageData {
                        width: width as usize,
                        height: height as usize,
                        bytes: decoded.into_raw().into(),
                    })
                    .map_err(|e| e.to_string())
            }
        }
    }

    fn copy_path_auto(&self, path: &str) -> Result<(), String> {
        let offer = build_auto_offer(path);
        match platform::clipboard_multi::set_offer(offer) {
            Ok(()) => Ok(()),
            Err(e) if e.contains("too large for one X11 property write") => self.copy_path_as(path, "image"),
            Err(_) => self.copy_path_as(path, "file"),
        }
    }

    fn toast(&self, title: &str, message: &str) {
        let _ = self.app.emit(
            EXTENSION_TOAST_EVENT,
            serde_json::json!({ "id": "screenshots-error", "style": "FAILURE", "title": title, "message": message }),
        );
    }
}

/// Builds the "Auto" paste format's offer: image pixels (when `path` is an
/// image), a file reference two different ways (`text/uri-list`, plus the
/// GNOME-file-manager-specific `x-special/gnome-copied-files` verb that
/// Nautilus/Thunar use so a paste into another file manager performs a real
/// copy), and the plain path as text — so whichever representation a paste
/// target understands, it gets something useful.
fn build_auto_offer(path: &str) -> Vec<platform::clipboard_multi::OfferEntry> {
    use platform::clipboard_multi::{gnome_copied_files_payload, path_to_file_uri, OfferEntry, Payload};

    let path_buf = Path::new(path);
    let uri = path_to_file_uri(path_buf);
    let extension = path_buf.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase());
    let is_image = extension.as_deref().map(|e| IMAGE_EXTENSIONS.contains(&e)).unwrap_or(false);

    let mut entries = vec![
        OfferEntry { target: "text/uri-list".into(), payload: Payload::Bytes(uri.clone().into_bytes()) },
        OfferEntry {
            target: "x-special/gnome-copied-files".into(),
            payload: Payload::Bytes(gnome_copied_files_payload(&uri)),
        },
        OfferEntry { target: "UTF8_STRING".into(), payload: Payload::Bytes(path.as_bytes().to_vec()) },
        OfferEntry { target: "text/plain;charset=utf-8".into(), payload: Payload::Bytes(path.as_bytes().to_vec()) },
        OfferEntry { target: "text/plain".into(), payload: Payload::Bytes(path.as_bytes().to_vec()) },
    ];

    if is_image {
        let is_png = extension.as_deref() == Some("png");
        let payload = if is_png {
            std::fs::read(path_buf).map(Payload::Bytes).unwrap_or_else(|_| Payload::LazyPngFromFile(path_buf.to_path_buf()))
        } else {
            Payload::LazyPngFromFile(path_buf.to_path_buf())
        };
        entries.push(OfferEntry { target: "image/png".into(), payload });
    }

    entries
}

fn pinned_paths(conn: &rusqlite::Connection) -> rusqlite::Result<HashSet<String>> {
    let mut stmt = conn.prepare("SELECT path FROM screenshot_pins")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    rows.collect()
}

fn indexed_texts(conn: &rusqlite::Connection) -> rusqlite::Result<HashMap<String, String>> {
    let mut stmt = conn.prepare("SELECT path, text FROM screenshot_ocr")?;
    let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
    rows.collect()
}

fn indexed_mtimes(conn: &rusqlite::Connection) -> rusqlite::Result<HashMap<String, i64>> {
    let mut stmt = conn.prepare("SELECT path, mtime FROM screenshot_ocr")?;
    let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))?;
    rows.collect()
}

fn indexed_paths(conn: &rusqlite::Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT path FROM screenshot_ocr")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    rows.collect()
}

/// A row is stale (needs re-indexing) when it's missing entirely or its
/// indexed `mtime` doesn't match the file's current one — an in-place
/// edit moves `mtime`, which is exactly the case this must catch.
fn needs_indexing(entry_mtime: i64, indexed_mtime: Option<i64>) -> bool {
    indexed_mtime != Some(entry_mtime)
}

/// Indexed rows whose path is no longer part of the live scan — deleted
/// or moved-away files whose OCR text would otherwise linger forever.
fn paths_to_prune(indexed_paths: &[String], live_paths: &HashSet<String>) -> Vec<String> {
    indexed_paths.iter().filter(|path| !live_paths.contains(path.as_str())).cloned().collect()
}

fn upsert_ocr_row(conn: &rusqlite::Connection, path: &str, mtime: i64, text: &str, engine: &str, indexed_at: i64) {
    let _ = conn.execute(
        "INSERT INTO screenshot_ocr (path, mtime, text, engine, indexed_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(path) DO UPDATE SET mtime = excluded.mtime, text = excluded.text, engine = excluded.engine, indexed_at = excluded.indexed_at",
        params![path, mtime, text, engine, indexed_at],
    );
}

/// Where generated video-thumbnail JPEGs live — the OS cache directory
/// (`~/.cache/<id>` on Linux, `~/Library/Caches/<id>` on macOS,
/// `%LOCALAPPDATA%\<id>` on Windows), not app-data: these are entirely
/// regenerable from the source video (see `needs_indexing`), the exact
/// kind of disposable-if-reclaimed content the OS cache directory is for,
/// unlike settings/the database/clipboard images which are real state. A
/// static entry in `tauri.conf.json`'s asset-protocol scope
/// (`$APPCACHE/video-thumbnails/**`) covers it, so unlike the
/// user-configured screenshot search scopes this needs no dynamic
/// `allow_directory` call.
fn thumbs_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_cache_dir().ok().map(|dir| dir.join("video-thumbnails"))
}

/// `thumb` is `""` for a row whose extraction failed — kept as a row
/// (not just absent) so a permanently-broken video isn't retried every
/// sweep, but `list()` must treat that as "no thumbnail" rather than
/// pointing at a file that doesn't exist.
fn indexed_thumbs(conn: &rusqlite::Connection) -> rusqlite::Result<HashMap<String, String>> {
    let mut stmt = conn.prepare("SELECT path, thumb FROM screenshot_thumbnails")?;
    let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
    rows.collect()
}

fn indexed_thumb_mtimes(conn: &rusqlite::Connection) -> rusqlite::Result<HashMap<String, i64>> {
    let mut stmt = conn.prepare("SELECT path, mtime FROM screenshot_thumbnails")?;
    let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))?;
    rows.collect()
}

fn indexed_thumb_paths(conn: &rusqlite::Connection) -> rusqlite::Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare("SELECT path, thumb FROM screenshot_thumbnails")?;
    let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
    rows.collect()
}

fn upsert_thumb_row(conn: &rusqlite::Connection, path: &str, mtime: i64, thumb: &str, generated_at: i64) {
    let _ = conn.execute(
        "INSERT INTO screenshot_thumbnails (path, mtime, thumb, generated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(path) DO UPDATE SET mtime = excluded.mtime, thumb = excluded.thumb, generated_at = excluded.generated_at",
        params![path, mtime, thumb, generated_at],
    );
}

/// The actual sweep body, run on a spawned thread by `spawn_index_sweep`.
/// Prunes vanished paths from both caches first, then — if enabled —
/// generates thumbnails for the newest `MAX_SWEEP_VIDEO_THUMBS` stale
/// videos, then — if enabled — OCRs the newest `MAX_SWEEP_IMAGES` stale
/// images (images only — videos are never OCR'd). Thumbnails run first:
/// extraction is roughly a hundred milliseconds a file versus OCR's
/// seconds, and it's the half a freshly opened grid is waiting to see.
///
/// Only the thumbnail pass fires `OCR_UPDATED_EVENT` incrementally, every
/// `SWEEP_EMIT_BATCH` rows — a new thumbnail is a visible grid change, and
/// there are at most `MAX_SWEEP_VIDEO_THUMBS` of them. OCR rows are
/// counted into the same `since_emit` counter but don't fire mid-loop: OCR
/// text has no visual representation in the grid (it only matters once the
/// user searches), so with up to `MAX_SWEEP_IMAGES` of them, emitting
/// per-batch there used to force an open view to refetch and re-render its
/// full entry list every couple of seconds for the entire OCR pass — long
/// after the thumbnails (the part actually worth showing progressively)
/// were done. The OCR pass's rows still reach the frontend, just as one
/// refetch when the whole sweep finishes (the trailing `since_emit > 0`
/// check below).
///
/// `cache` is cleared right before each emit, not just relied on to
/// expire naturally: the whole point of the per-batch event is that an
/// open view refetches immediately, but `list()`'s 3-second scan cache
/// can otherwise still be warm from the very `list()` call that kicked
/// this sweep off, which would silently hand that refetch stale
/// (pre-index) entries until the TTL happened to lapse on its own.
/// Which entries `trash_expired_entries` would act on: unpinned, older
/// than the `storage_duration` cutoff. Pure and separately testable from
/// the actual trash side effect. `storage_duration` a day-count string;
/// returns empty for `"unlimited"` or an unparseable value.
fn paths_past_storage_duration<'a>(entries: &'a [MediaEntry], storage_duration: &str, now: i64) -> Vec<&'a str> {
    let Ok(days) = storage_duration.parse::<i64>() else { return Vec::new() };
    let cutoff = now - days * 86_400;
    entries.iter().filter(|e| !e.pinned && e.created_at < cutoff).map(|e| e.path.as_str()).collect()
}

/// Moves screenshot files older than `storage_duration` (a day-count
/// string; never called with `"unlimited"`) to the OS trash — recoverable,
/// never a permanent delete, via the same `SystemTrash` port
/// `system_commands`'s "Empty Trash"/"Open Trash" actions use. Pinned
/// entries (already joined into `entries` by the `list()` call that
/// produced them) are always skipped. Runs on the sweep's own
/// lowered-priority background thread, gated to at most once per real day
/// by `spawn_index_sweep`'s `trash_sweep_due` check before this is ever
/// called — this function itself doesn't re-check timing.
fn trash_expired_entries(entries: &[MediaEntry], storage_duration: &str) {
    for path in paths_past_storage_duration(entries, storage_duration, now_unix()) {
        if let Err(e) = SystemTrash.trash(path) {
            log::warn!("failed to trash expired screenshot '{path}': {e}");
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn run_index_sweep(
    conn: &SharedConnection,
    app: &AppHandle,
    cache: &ScanCache,
    entries: &[MediaEntry],
    ocr_active: bool,
    thumbs_active: bool,
    thumbs_dir: Option<&Path>,
) {
    let live_paths: HashSet<String> = entries.iter().map(|entry| entry.path.clone()).collect();
    let mut since_emit = 0usize;

    let (existing_ocr_paths, existing_ocr_mtimes) = {
        let c = conn.lock().unwrap();
        (indexed_paths(&c).unwrap_or_default(), indexed_mtimes(&c).unwrap_or_default())
    };
    for path in paths_to_prune(&existing_ocr_paths, &live_paths) {
        let c = conn.lock().unwrap();
        let _ = c.execute("DELETE FROM screenshot_ocr WHERE path = ?1", params![path]);
    }

    let existing_thumbs = { indexed_thumb_paths(&conn.lock().unwrap()).unwrap_or_default() };
    for (path, thumb) in &existing_thumbs {
        if live_paths.contains(path) {
            continue;
        }
        if !thumb.is_empty() {
            if let Some(dir) = thumbs_dir {
                std::fs::remove_file(dir.join(thumb)).ok();
            }
        }
        let c = conn.lock().unwrap();
        let _ = c.execute("DELETE FROM screenshot_thumbnails WHERE path = ?1", params![path]);
    }

    if thumbs_active {
        if let Some(dir) = thumbs_dir {
            let existing_thumb_mtimes = { indexed_thumb_mtimes(&conn.lock().unwrap()).unwrap_or_default() };
            let mut processed = 0usize;
            for entry in entries.iter().filter(|entry| entry.kind == "video") {
                if processed >= MAX_SWEEP_VIDEO_THUMBS {
                    break;
                }
                if !needs_indexing(entry.modified_at, existing_thumb_mtimes.get(&entry.path).copied()) {
                    continue;
                }
                processed += 1;

                let filename = video_thumbs::thumb_filename(&entry.path);
                let dst = dir.join(&filename);
                let thumb = match video_thumbs::generate(Path::new(&entry.path), &dst) {
                    Ok(()) => filename,
                    Err(_) => String::new(),
                };
                {
                    let c = conn.lock().unwrap();
                    upsert_thumb_row(&c, &entry.path, entry.modified_at, &thumb, now_unix());
                }

                since_emit += 1;
                if since_emit >= SWEEP_EMIT_BATCH {
                    *cache.write().unwrap() = None;
                    let _ = app.emit(OCR_UPDATED_EVENT, ());
                    since_emit = 0;
                }
            }
        }
    }

    if ocr_active {
        let engine = platform::ocr::engine_name();
        let mut processed = 0usize;
        for entry in entries.iter().filter(|entry| entry.kind == "image") {
            if processed >= MAX_SWEEP_IMAGES {
                break;
            }
            if !needs_indexing(entry.modified_at, existing_ocr_mtimes.get(&entry.path).copied()) {
                continue;
            }
            processed += 1;

            let text = platform::ocr::extract_text(Path::new(&entry.path)).unwrap_or_default();
            {
                let c = conn.lock().unwrap();
                upsert_ocr_row(&c, &entry.path, entry.modified_at, &text, engine, now_unix());
            }

            // No per-batch emit here — see the doc comment above this
            // function for why OCR rows only trigger the trailing emit.
            since_emit += 1;
        }
    }

    if since_emit > 0 {
        *cache.write().unwrap() = None;
        let _ = app.emit(OCR_UPDATED_EVENT, ());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn media_entry(path: &str, created_at: i64, pinned: bool) -> MediaEntry {
        MediaEntry {
            path: path.into(),
            name: path.into(),
            created_at,
            modified_at: created_at,
            kind: "image".into(),
            ocr_text: None,
            thumbnail_path: None,
            pinned,
        }
    }

    #[test]
    fn paths_past_storage_duration_selects_only_unpinned_entries_older_than_the_cutoff() {
        let now = 1_000_000_i64;
        let entries = vec![
            media_entry("/old-unpinned.png", now - 10 * 86_400, false),
            media_entry("/old-pinned.png", now - 10 * 86_400, true),
            media_entry("/recent-unpinned.png", now - 86_400, false),
        ];

        let expired = paths_past_storage_duration(&entries, "7", now);

        assert_eq!(expired, vec!["/old-unpinned.png"]);
    }

    #[test]
    fn paths_past_storage_duration_is_empty_for_unlimited() {
        let now = 1_000_000_i64;
        let entries = vec![media_entry("/very-old.png", now - 1000 * 86_400, false)];

        assert!(paths_past_storage_duration(&entries, "unlimited", now).is_empty());
    }

    #[test]
    fn classify_extension_recognizes_images_videos_and_ignores_others() {
        let video_extensions = vec!["mp4".to_string(), "mov".to_string()];
        assert_eq!(classify_extension("png", &video_extensions), Some("image"));
        assert_eq!(classify_extension("PNG", &video_extensions), Some("image"));
        assert_eq!(classify_extension("mp4", &video_extensions), Some("video"));
        assert_eq!(classify_extension("MOV", &video_extensions), Some("video"));
        assert_eq!(classify_extension("txt", &video_extensions), None);
    }

    #[test]
    fn build_auto_offer_includes_image_png_target_only_for_image_paths() {
        let image_offer = build_auto_offer("/home/user/Pictures/shot.jpg");
        assert!(image_offer.iter().any(|entry| entry.target == "image/png"));
        assert!(image_offer.iter().any(|entry| entry.target == "text/uri-list"));
        assert!(image_offer.iter().any(|entry| entry.target == "x-special/gnome-copied-files"));

        let video_offer = build_auto_offer("/home/user/Videos/clip.mp4");
        assert!(!video_offer.iter().any(|entry| entry.target == "image/png"));
        assert!(video_offer.iter().any(|entry| entry.target == "text/uri-list"));
    }

    /// Live X11 verification for `plans/auto-paste-format.md` T3/T8 — not
    /// run by the normal suite since it needs a real X server and `xclip`
    /// on `$DISPLAY`. Run manually against an isolated display, together
    /// with its sibling `#[ignore]` tests in this module — `--test-
    /// threads=1` matters, since they all read/write the one real X11
    /// clipboard and race each other under the default parallel runner:
    /// `DISPLAY=:1 cargo test --lib --features custom-protocol -- --ignored --test-threads=1`
    #[test]
    #[ignore]
    fn auto_offer_round_trips_through_a_live_x11_clipboard() {
        use std::process::Command;

        fn xclip_out(target: &str) -> Vec<u8> {
            Command::new("xclip")
                .args(["-selection", "clipboard", "-o", "-t", target])
                .output()
                .expect("xclip should run")
                .stdout
        }

        let dir = std::env::temp_dir().join("openray-auto-offer-test");
        std::fs::create_dir_all(&dir).unwrap();

        // PNG (raw-bytes payload path) — 2x2 red square.
        let png_path = dir.join("shot.png");
        let img = image::RgbaImage::from_pixel(2, 2, image::Rgba([255, 0, 0, 255]));
        img.save(&png_path).unwrap();

        let offer = build_auto_offer(png_path.to_str().unwrap());
        platform::clipboard_multi::set_offer(offer).expect("set_offer should succeed on a live X server");

        let targets = String::from_utf8(xclip_out("TARGETS")).unwrap();
        for expected in ["image/png", "text/uri-list", "x-special/gnome-copied-files", "UTF8_STRING", "TARGETS"] {
            assert!(targets.contains(expected), "TARGETS missing {expected}, got: {targets}");
        }

        let uri_list = String::from_utf8(xclip_out("text/uri-list")).unwrap();
        assert!(uri_list.contains("shot.png"), "unexpected uri-list: {uri_list}");

        let gnome_payload = String::from_utf8(xclip_out("x-special/gnome-copied-files")).unwrap();
        assert!(gnome_payload.starts_with("copy\n"), "unexpected gnome payload: {gnome_payload}");
        assert!(gnome_payload.contains("shot.png"), "unexpected gnome payload: {gnome_payload}");

        let path_text = String::from_utf8(xclip_out("UTF8_STRING")).unwrap();
        assert_eq!(path_text, png_path.to_str().unwrap());

        let png_bytes = xclip_out("image/png");
        assert_eq!(&png_bytes[..8], b"\x89PNG\r\n\x1a\n", "image/png target did not return valid PNG bytes");

        // JPEG (lazy-encode payload path) — same content, different
        // extension, so `image/png` must still resolve to real PNG bytes
        // encoded on first request rather than being absent or raw JPEG.
        let jpg_path = dir.join("shot.jpg");
        image::DynamicImage::ImageRgba8(img.clone()).to_rgb8().save(&jpg_path).unwrap();
        let offer = build_auto_offer(jpg_path.to_str().unwrap());
        platform::clipboard_multi::set_offer(offer).expect("set_offer should succeed for the jpeg offer");
        let png_bytes = xclip_out("image/png");
        assert_eq!(&png_bytes[..8], b"\x89PNG\r\n\x1a\n", "lazy-encoded image/png was not valid PNG bytes");

        // Video extension — no image/png target should be offered.
        let clip_path = dir.join("clip.mp4");
        let offer = build_auto_offer(clip_path.to_str().unwrap());
        platform::clipboard_multi::set_offer(offer).expect("set_offer should succeed for the video offer");
        let targets = String::from_utf8(xclip_out("TARGETS")).unwrap();
        assert!(!targets.contains("image/png"), "video offer should not include image/png, got: {targets}");
        assert!(targets.contains("text/uri-list"), "video offer should still include text/uri-list, got: {targets}");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Live X11 verification, T8's `SelectionClear` interop check — run
    /// manually the same way as
    /// `auto_offer_round_trips_through_a_live_x11_clipboard`.
    #[test]
    #[ignore]
    fn auto_offer_survives_losing_and_reclaiming_the_selection() {
        use std::process::Command;

        let dir = std::env::temp_dir().join("openray-auto-offer-clear-test");
        std::fs::create_dir_all(&dir).unwrap();
        let png_path = dir.join("shot.png");
        image::RgbaImage::from_pixel(2, 2, image::Rgba([0, 255, 0, 255])).save(&png_path).unwrap();

        let offer = build_auto_offer(png_path.to_str().unwrap());
        platform::clipboard_multi::set_offer(offer).expect("first claim should succeed");
        let targets = String::from_utf8(
            Command::new("xclip").args(["-selection", "clipboard", "-o", "-t", "TARGETS"]).output().unwrap().stdout,
        )
        .unwrap();
        assert!(targets.contains("image/png"), "expected our offer's TARGETS before losing the selection");

        // A different process claims the selection — our server should
        // see `SelectionClear` and drop the offer (no crash, no stale
        // state) rather than keep answering for content it no longer
        // owns.
        Command::new("sh")
            .arg("-c")
            .arg("echo -n outside-owner | xclip -selection clipboard -i")
            .status()
            .expect("xclip -i should run");
        std::thread::sleep(std::time::Duration::from_millis(200));
        let text = String::from_utf8(
            Command::new("xclip").args(["-selection", "clipboard", "-o"]).output().unwrap().stdout,
        )
        .unwrap();
        assert_eq!(text, "outside-owner", "the outside claim should now own the selection");

        // Reclaiming afterward must still work — the server thread isn't
        // wedged by having lost ownership once.
        let offer = build_auto_offer(png_path.to_str().unwrap());
        platform::clipboard_multi::set_offer(offer).expect("reclaiming after SelectionClear should succeed");
        let targets = String::from_utf8(
            Command::new("xclip").args(["-selection", "clipboard", "-o", "-t", "TARGETS"]).output().unwrap().stdout,
        )
        .unwrap();
        assert!(targets.contains("image/png"), "expected our offer's TARGETS again after reclaiming");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Live X11 verification, T8's "explicit formats unaffected by
    /// `\"auto\"`" check — confirms adding the `\"auto\"` match arm ahead
    /// of the pre-existing `\"file\"`/`\"path\"`/image arms in
    /// `copy_path_as` didn't change their (arboard-backed) output.
    #[test]
    #[ignore]
    fn explicit_formats_are_byte_identical_to_before_auto_existed() {
        use std::process::Command;

        fn xclip_out(target: &str) -> Vec<u8> {
            Command::new("xclip")
                .args(["-selection", "clipboard", "-o", "-t", target])
                .output()
                .expect("xclip should run")
                .stdout
        }

        let dir = std::env::temp_dir().join("openray-explicit-format-test");
        std::fs::create_dir_all(&dir).unwrap();
        let png_path = dir.join("shot.png");
        let img = image::RgbaImage::from_pixel(3, 3, image::Rgba([0, 0, 255, 255]));
        img.save(&png_path).unwrap();
        let path = png_path.to_str().unwrap();

        let mut clipboard = arboard::Clipboard::new().unwrap();
        clipboard.set().file_list(&[path]).unwrap();
        assert_eq!(String::from_utf8(xclip_out("text/uri-list")).unwrap().trim(), platform::clipboard_multi::path_to_file_uri(&png_path));

        let mut clipboard = arboard::Clipboard::new().unwrap();
        clipboard.set_text(path).unwrap();
        assert_eq!(xclip_out("UTF8_STRING"), path.as_bytes());

        let decoded = image::open(&png_path).unwrap().to_rgba8();
        let (width, height) = decoded.dimensions();
        let mut clipboard = arboard::Clipboard::new().unwrap();
        clipboard
            .set_image(arboard::ImageData { width: width as usize, height: height as usize, bytes: decoded.into_raw().into() })
            .unwrap();
        let png_bytes = xclip_out("image/png");
        assert_eq!(&png_bytes[..8], b"\x89PNG\r\n\x1a\n", "arboard's image write should still be readable as PNG");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn resolve_created_at_falls_back_to_modified_when_created_is_unavailable() {
        assert_eq!(resolve_created_at(Some(100), 50), 100);
        assert_eq!(resolve_created_at(None, 50), 50);
    }

    #[test]
    fn scan_scopes_orders_entries_newest_first_and_skips_unknown_extensions() {
        let dir = std::env::temp_dir().join(format!("openray-screenshots-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        let old_path = dir.join("old.png");
        let clip_path = dir.join("clip.mp4");
        let new_path = dir.join("new.png");
        let ignored_path = dir.join("notes.txt");
        // Written in the same order asserted below (oldest to newest) so
        // the test passes whether the filesystem honors real birthtimes
        // (statx) or `scan_scopes` falls back to modification time — both
        // are set to agree, rather than relying on either alone.
        std::fs::write(&old_path, b"old").unwrap();
        std::fs::write(&clip_path, b"clip").unwrap();
        std::fs::write(&new_path, b"new").unwrap();
        std::fs::write(&ignored_path, b"ignored").unwrap();

        let now = SystemTime::now();
        std::fs::File::open(&old_path).unwrap().set_modified(now - Duration::from_secs(100)).unwrap();
        std::fs::File::open(&clip_path).unwrap().set_modified(now - Duration::from_secs(50)).unwrap();
        std::fs::File::open(&new_path).unwrap().set_modified(now).unwrap();

        let video_extensions = vec!["mp4".to_string()];
        let entries = scan_scopes(&[dir.display().to_string()], &video_extensions);
        std::fs::remove_dir_all(&dir).unwrap();

        assert_eq!(entries.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), vec!["new.png", "clip.mp4", "old.png"]);
        assert_eq!(entries[0].kind, "image");
        assert_eq!(entries[1].kind, "video");
    }

    #[test]
    fn scan_scopes_breaks_same_truncated_second_ties_by_sub_second_precision() {
        // Found via live QA: four fixture files all landed in the same
        // wall-clock second, and the pre-fix sort (on the already-
        // truncated-to-seconds `created_at`) left them tied, falling back
        // to arbitrary directory scan order instead of real creation
        // order. Two files written back-to-back with no artificial delay
        // reproduce that same-second collision on a filesystem with
        // sub-second birthtime/mtime resolution (the common case).
        let dir = std::env::temp_dir().join(format!("openray-screenshots-tie-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        let first_path = dir.join("first.png");
        let second_path = dir.join("second.png");
        std::fs::write(&first_path, b"first").unwrap();
        std::fs::write(&second_path, b"second").unwrap();

        let entries = scan_scopes(&[dir.display().to_string()], &[]);
        std::fs::remove_dir_all(&dir).unwrap();

        assert_eq!(entries.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), vec!["second.png", "first.png"]);
    }

    #[test]
    fn needs_indexing_catches_missing_and_stale_rows() {
        assert!(needs_indexing(100, None));
        assert!(needs_indexing(100, Some(99)));
        assert!(!needs_indexing(100, Some(100)));
    }

    #[test]
    fn paths_to_prune_removes_only_vanished_paths() {
        let indexed = vec!["/a.png".to_string(), "/b.png".to_string(), "/c.png".to_string()];
        let live: HashSet<String> = ["/a.png".to_string(), "/c.png".to_string()].into_iter().collect();
        assert_eq!(paths_to_prune(&indexed, &live), vec!["/b.png".to_string()]);
    }

    fn test_ocr_db() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE screenshot_ocr (
                path TEXT PRIMARY KEY,
                mtime INTEGER NOT NULL,
                text TEXT NOT NULL,
                engine TEXT NOT NULL,
                indexed_at INTEGER NOT NULL
            );",
        )
        .unwrap();
        conn
    }

    #[test]
    fn upsert_ocr_row_inserts_then_overwrites_on_conflict() {
        let conn = test_ocr_db();
        upsert_ocr_row(&conn, "/a.png", 100, "hello", "Tesseract", 1000);
        assert_eq!(indexed_mtimes(&conn).unwrap().get("/a.png"), Some(&100));
        assert_eq!(indexed_texts(&conn).unwrap().get("/a.png").map(String::as_str), Some("hello"));

        upsert_ocr_row(&conn, "/a.png", 200, "updated", "Tesseract", 2000);
        assert_eq!(indexed_mtimes(&conn).unwrap().get("/a.png"), Some(&200));
        assert_eq!(indexed_texts(&conn).unwrap().get("/a.png").map(String::as_str), Some("updated"));
        assert_eq!(indexed_paths(&conn).unwrap().len(), 1);
    }

    fn test_thumbs_db() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE screenshot_thumbnails (
                path TEXT PRIMARY KEY,
                mtime INTEGER NOT NULL,
                thumb TEXT NOT NULL,
                generated_at INTEGER NOT NULL
            );",
        )
        .unwrap();
        conn
    }

    #[test]
    fn upsert_thumb_row_inserts_then_overwrites_on_conflict() {
        let conn = test_thumbs_db();
        upsert_thumb_row(&conn, "/a.mp4", 100, "abc123.jpg", 1000);
        assert_eq!(indexed_thumb_mtimes(&conn).unwrap().get("/a.mp4"), Some(&100));
        assert_eq!(indexed_thumbs(&conn).unwrap().get("/a.mp4").map(String::as_str), Some("abc123.jpg"));

        upsert_thumb_row(&conn, "/a.mp4", 200, "def456.jpg", 2000);
        assert_eq!(indexed_thumb_mtimes(&conn).unwrap().get("/a.mp4"), Some(&200));
        assert_eq!(indexed_thumbs(&conn).unwrap().get("/a.mp4").map(String::as_str), Some("def456.jpg"));
        assert_eq!(indexed_thumb_paths(&conn).unwrap().len(), 1);
    }

    #[test]
    fn upsert_thumb_row_stores_an_empty_thumb_for_a_failed_extraction() {
        let conn = test_thumbs_db();
        upsert_thumb_row(&conn, "/broken.mp4", 100, "", 1000);
        // A row exists (so the sweep won't retry every time) but with no
        // thumb filename — `list()` must treat this as "no thumbnail".
        assert_eq!(indexed_thumb_mtimes(&conn).unwrap().get("/broken.mp4"), Some(&100));
        assert_eq!(indexed_thumbs(&conn).unwrap().get("/broken.mp4").map(String::as_str), Some(""));
    }
}
