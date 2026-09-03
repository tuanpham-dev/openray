//! Snippet auto-expansion: type a snippet's keyword in any app and it is
//! replaced in place with the expanded body.
//!
//! This module has two halves. The **pure matcher** (`TriggerMode`,
//! `KeywordEntry`, `process_key`, `load_keywords`) is plain data-in/data-out
//! logic with no OS input, no Tauri runtime, and full unit tests — the same
//! testability discipline `hotkey::build_desired_bindings` and
//! `hotkey_dispatch::classify` follow. The **service** (`AutoExpander`, added
//! in a later task) owns the platform keystroke listener and drives the
//! resolve → delete → paste → caret insertion.
//!
//! Keyword source: snippets live in the `extension_storage` table under
//! `extension_id = "snippets"`, one JSON row per snippet. The stored value is
//! a JSON *string* (a live `JSON.stringify(snippet)` write, and migration
//! `0022_snippets_to_extension_storage.sql` matches that shape), so the loader
//! parses twice — once for `ExtensionStorage::all` to hand back the row value,
//! then once more to turn that string into the snippet object.

use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::application::extension_storage::ExtensionStorage;
use crate::application::state::AppState;
use crate::infrastructure::paste;
use crate::infrastructure::session_env::is_wayland;

/// Frontend event emitted when auto-expansion can't run (Wayland, or a
/// missing macOS Input-Monitoring grant) — the Snippets pane shows a banner.
pub const AUTO_EXPAND_UNAVAILABLE_EVENT: &str = "snippet-auto-expand-unavailable";

/// How often the keyword map is re-read from storage, so create/edit/delete
/// take effect without a restart. Runs on its own thread, off the keystroke
/// hot path.
const REFRESH_INTERVAL: Duration = Duration::from_secs(2);

/// How a keyword triggers an expansion.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TriggerMode {
    /// Expand the moment the typed buffer ends with a keyword.
    Instant,
    /// Expand only when a keyword is immediately followed by a delimiter
    /// (space, tab, or enter); the delimiter is consumed by the expansion.
    Delimiter,
}

impl TriggerMode {
    /// Parses the `snippet_auto_expand_mode` setting string; anything
    /// unexpected falls back to `Instant` (mirrors the settings clamp).
    pub fn from_setting(mode: &str) -> Self {
        match mode {
            "delimiter" => TriggerMode::Delimiter,
            _ => TriggerMode::Instant,
        }
    }
}

/// One auto-expandable snippet: its trigger keyword and the id used to ask
/// the extension host to resolve it. `requires_argument` snippets are kept in
/// the list but never matched — inline expansion can't prompt for an argument.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeywordEntry {
    pub keyword: String,
    pub snippet_id: String,
    pub requires_argument: bool,
}

/// A matched expansion: which snippet to resolve, and how many characters
/// (the keyword, plus the delimiter in `Delimiter` mode) to delete from the
/// target app before pasting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Match {
    pub snippet_id: String,
    pub backspaces: usize,
}

/// One classified keystroke handed to the matcher. The service translates a
/// raw native key event into this; the matcher stays free of any input backend.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Key {
    /// A printable character typed (letters, digits, punctuation).
    Char(char),
    /// A word-boundary key: space, tab, or enter.
    Delimiter,
    /// Backspace — removes the last buffered character.
    Backspace,
    /// Anything that should abandon the current buffer without matching:
    /// arrow keys, Home/End, Escape, a chord with Ctrl/Cmd/Alt, a click, etc.
    Reset,
}

/// Upper bound on the rolling buffer; keeps the suffix. Comfortably longer
/// than any sane keyword, so an instant `ends_with` check never misses.
const MAX_BUFFER: usize = 128;

/// Advances the rolling buffer by one classified key and returns a `Match`
/// when this key completes a keyword under `mode`.
///
/// - `Char` appends, then (Instant mode) checks whether the buffer now ends
///   with a keyword.
/// - `Delimiter` (Delimiter mode) checks whether the word just before it is a
///   keyword; on a hit the keyword **and** the delimiter are deleted. Either
///   way a delimiter ends the current word, so the buffer is cleared.
/// - `Backspace` pops one char; `Reset` clears the buffer.
///
/// On any match the buffer is cleared so the same keystrokes can't re-fire.
pub fn process_key(buffer: &mut String, key: Key, keywords: &[KeywordEntry], mode: TriggerMode) -> Option<Match> {
    match key {
        Key::Char(c) => {
            buffer.push(c);
            trim_front(buffer);
            if mode == TriggerMode::Instant {
                if let Some(entry) = longest_suffix_keyword(buffer, keywords) {
                    let m = Match { snippet_id: entry.snippet_id.clone(), backspaces: entry.keyword.chars().count() };
                    buffer.clear();
                    return Some(m);
                }
            }
            None
        }
        Key::Delimiter => {
            let result = if mode == TriggerMode::Delimiter {
                longest_suffix_keyword(buffer, keywords).map(|entry| Match {
                    snippet_id: entry.snippet_id.clone(),
                    // keyword + the delimiter the user just typed
                    backspaces: entry.keyword.chars().count() + 1,
                })
            } else {
                None
            };
            buffer.clear();
            result
        }
        Key::Backspace => {
            buffer.pop();
            None
        }
        Key::Reset => {
            buffer.clear();
            None
        }
    }
}

/// The longest keyword that is a suffix of `buffer`, skipping
/// argument-taking snippets (which can't be auto-expanded). Longest wins so
/// `signature` beats `sig` when both end at the same position.
fn longest_suffix_keyword<'a>(buffer: &str, keywords: &'a [KeywordEntry]) -> Option<&'a KeywordEntry> {
    keywords
        .iter()
        .filter(|entry| !entry.requires_argument && !entry.keyword.is_empty() && buffer.ends_with(&entry.keyword))
        .max_by_key(|entry| entry.keyword.chars().count())
}

/// Caps buffer growth, keeping the most recent `MAX_BUFFER` chars so an
/// `ends_with` check on the tail is unaffected.
fn trim_front(buffer: &mut String) {
    let len = buffer.chars().count();
    if len > MAX_BUFFER {
        let start = buffer.char_indices().nth(len - MAX_BUFFER).map(|(i, _)| i).unwrap_or(0);
        buffer.drain(..start);
    }
}

/// Whether a snippet body prompts for an argument — mirrors the TS
/// `takesArgument`/`argumentSpecs` intent with a cheap `{argument` scan.
/// Errs toward marking a snippet ineligible, which is the safe direction.
pub fn body_contains_argument_token(body: &str) -> bool {
    body.contains("{argument")
}

/// A snippet as stored in `extension_storage` (only the fields auto-expansion
/// needs). Matches `extensions/snippets/src/storage.ts`'s `Snippet`.
#[derive(Debug, Deserialize)]
struct SnippetRecord {
    id: String,
    #[serde(default)]
    keyword: Option<String>,
    #[serde(default)]
    body: String,
}

/// Reads every snippet from storage and returns the auto-expandable ones (a
/// non-empty keyword). Argument-taking snippets are included but flagged so
/// the matcher can keep the list stable while never firing them.
pub fn load_keywords(storage: &ExtensionStorage) -> Vec<KeywordEntry> {
    let all = match storage.all("snippets") {
        Ok(value) => value,
        Err(e) => {
            log::warn!("auto-expand: failed to read snippets storage: {e}");
            return Vec::new();
        }
    };
    let Some(map) = all.as_object() else { return Vec::new() };

    let mut entries = Vec::new();
    for value in map.values() {
        // Stored as a JSON string (see the module doc); tolerate a bare
        // object too in case a future writer stores it unquoted.
        let record: Option<SnippetRecord> = match value {
            serde_json::Value::String(s) => serde_json::from_str(s).ok(),
            serde_json::Value::Object(_) => serde_json::from_value(value.clone()).ok(),
            _ => None,
        };
        let Some(record) = record else { continue };
        let Some(keyword) = record.keyword.filter(|k| !k.is_empty()) else { continue };
        entries.push(KeywordEntry {
            keyword,
            snippet_id: record.id,
            requires_argument: body_contains_argument_token(&record.body),
        });
    }
    entries
}

/// Whether this platform can observe and inject keystrokes for
/// auto-expansion at all. False on Wayland — no client may watch or
/// synthesize keys into another app there. (macOS additionally requires the
/// Input-Monitoring grant, checked at start time in `macos_input_monitoring`.)
pub fn available() -> bool {
    !is_wayland()
}

const MODE_INSTANT: u8 = 0;
const MODE_DELIMITER: u8 = 1;

/// Shared state between the public handle, the platform listener thread, and
/// the keyword-refresher thread.
struct Shared {
    /// Whether expansion is active. Toggled live from Settings; the listener
    /// callback and refresher both read it each iteration (pause, not stop).
    enabled: AtomicBool,
    /// True while an expansion's own synthetic keystrokes are being injected,
    /// so the listener ignores them instead of corrupting the buffer.
    expanding: AtomicBool,
    /// `MODE_INSTANT` or `MODE_DELIMITER`.
    mode: AtomicU8,
    /// Whether the listener/refresher threads have been spawned (once ever).
    started: AtomicBool,
    /// The current eligible keywords, refreshed from storage.
    keywords: Mutex<Vec<KeywordEntry>>,
}

impl Shared {
    fn mode(&self) -> TriggerMode {
        match self.mode.load(Ordering::Relaxed) {
            MODE_DELIMITER => TriggerMode::Delimiter,
            _ => TriggerMode::Instant,
        }
    }
}

/// The snippet auto-expansion service. Owns the global keystroke listener
/// (started lazily on first enable, then paused via an atomic — the native
/// taps run for the app's lifetime and aren't torn down) and drives the
/// resolve → delete → paste → caret insertion. Stored as an `AppState` field,
/// like `ClipboardWatcher`.
pub struct AutoExpander {
    shared: Arc<Shared>,
}

impl AutoExpander {
    pub fn new() -> Self {
        Self {
            shared: Arc::new(Shared {
                enabled: AtomicBool::new(false),
                expanding: AtomicBool::new(false),
                mode: AtomicU8::new(MODE_INSTANT),
                started: AtomicBool::new(false),
                keywords: Mutex::new(Vec::new()),
            }),
        }
    }

    /// Applies the enable flag and mode from settings, starting the listener
    /// if now enabled. Called once at startup and again on every settings
    /// save (`api::settings::update_settings`).
    pub fn apply_settings(&self, app: &AppHandle, enabled: bool, mode: &str) {
        self.set_mode(mode);
        self.set_enabled(app, enabled);
    }

    /// Turns expansion on or off live. Enabling for the first time spawns the
    /// listener (which is where the macOS Input-Monitoring prompt appears).
    pub fn set_enabled(&self, app: &AppHandle, enabled: bool) {
        self.shared.enabled.store(enabled, Ordering::SeqCst);
        if enabled {
            self.ensure_started(app);
        }
    }

    pub fn set_mode(&self, mode: &str) {
        let value = if TriggerMode::from_setting(mode) == TriggerMode::Delimiter { MODE_DELIMITER } else { MODE_INSTANT };
        self.shared.mode.store(value, Ordering::SeqCst);
    }

    fn ensure_started(&self, app: &AppHandle) {
        if self.shared.started.swap(true, Ordering::SeqCst) {
            return; // already started once
        }

        if !available() {
            let _ = app.emit(AUTO_EXPAND_UNAVAILABLE_EVENT, "wayland");
            self.shared.started.store(false, Ordering::SeqCst);
            return;
        }

        #[cfg(target_os = "macos")]
        {
            // The CGEventTap and enigo's injection BOTH need Accessibility —
            // without it, macOS silently drops tap events with no error. Some
            // macOS versions additionally attribute a HID listen tap to Input
            // Monitoring, so prompt that too — but gate only on Accessibility,
            // the requirement we're certain of.
            let accessibility = crate::infrastructure::platform::macos_accessibility::ensure_trusted_with_prompt();
            let input_monitoring = crate::infrastructure::platform::macos_input_monitoring::ensure_trusted_with_prompt();
            log::info!("auto-expand: macOS permissions — accessibility={accessibility}, input_monitoring={input_monitoring}");
            if !accessibility {
                // The prompt is now showing (or was dismissed). Report and let
                // a later toggle retry once the user has granted it.
                let _ = app.emit(AUTO_EXPAND_UNAVAILABLE_EVENT, "accessibility");
                self.shared.started.store(false, Ordering::SeqCst);
                return;
            }
        }

        log::info!("auto-expand: starting keystroke listener (mode={:?})", self.shared.mode());

        // Load the keyword map once before listening so the very first
        // keystroke can already match.
        refresh_keywords(&self.shared, app);
        spawn_refresher(Arc::clone(&self.shared), app.clone());
        spawn_listener(Arc::clone(&self.shared), app.clone());
    }
}

impl Default for AutoExpander {
    fn default() -> Self {
        Self::new()
    }
}

fn refresh_keywords(shared: &Shared, app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else { return };
    let keywords = load_keywords(&state.extension_storage);
    *shared.keywords.lock().unwrap() = keywords;
}

fn spawn_refresher(shared: Arc<Shared>, app: AppHandle) {
    thread::spawn(move || loop {
        thread::sleep(REFRESH_INTERVAL);
        if !shared.enabled.load(Ordering::Relaxed) {
            continue;
        }
        refresh_keywords(&shared, &app);
    });
}

/// Starts the platform keystroke listener — a native tap on each OS, all
/// funneling classified keys into `process_and_fire`:
/// - macOS: a CGEventTap on the main run loop (`macos_keytap`).
/// - Windows: a `WH_KEYBOARD_LL` hook (`windows_keytap`).
/// - Linux/X11: an XRecord tap (`linux_keytap`).
fn spawn_listener(shared: Arc<Shared>, app: AppHandle) {
    #[cfg(target_os = "macos")]
    start_macos_tap(shared, app);
    #[cfg(target_os = "windows")]
    start_windows_tap(shared, app);
    #[cfg(target_os = "linux")]
    start_linux_tap(shared, app);
}

/// Shared tail for both listeners: advance the buffer by one key and, on a
/// match, fire the async expansion. Assumes `expanding` was already checked by
/// the caller (so our own injected keys never reach here).
fn process_and_fire(shared: &Arc<Shared>, app: &AppHandle, buffer: &mut String, key: Key) {
    if !shared.enabled.load(Ordering::Relaxed) {
        buffer.clear();
        return;
    }

    let keywords = shared.keywords.lock().unwrap();
    let mode = shared.mode();
    let Some(matched) = process_key(buffer, key, &keywords, mode) else {
        return;
    };
    drop(keywords);

    log::info!("auto-expand: matched snippet '{}' ({} backspaces)", matched.snippet_id, matched.backspaces);
    shared.expanding.store(true, Ordering::SeqCst);
    let app = app.clone();
    let shared = Arc::clone(shared);
    tauri::async_runtime::spawn(async move {
        if let Err(e) = expand(&app, &matched.snippet_id, matched.backspaces).await {
            log::warn!("auto-expand: expansion of '{}' failed: {e}", matched.snippet_id);
        }
        shared.expanding.store(false, Ordering::SeqCst);
    });
}

/// macOS: install the native event tap on the main run loop, handing each
/// decoded key-down to the matcher. The buffer lives in a `Mutex` because the
/// handler is `Fn` (called repeatedly on the main thread), not an owning
/// `FnMut`.
#[cfg(target_os = "macos")]
fn start_macos_tap(shared: Arc<Shared>, app: AppHandle) {
    use crate::infrastructure::platform::macos_keytap::{self, MacKeyEvent};

    let buffer = std::sync::Mutex::new(String::new());
    let seen_first = AtomicBool::new(false);
    let handler_app = app.clone();

    let handler = move |ev: MacKeyEvent| {
        if !seen_first.swap(true, Ordering::Relaxed) {
            log::info!("auto-expand: first keystroke event received — the tap is delivering");
        }
        if shared.expanding.load(Ordering::Relaxed) {
            return;
        }
        let Some(key) = classify_macos(&ev) else {
            return;
        };
        let mut buffer = buffer.lock().unwrap();
        process_and_fire(&shared, &handler_app, &mut buffer, key);
    };

    if let Err(e) = macos_keytap::start(&app, Box::new(handler)) {
        log::warn!("auto-expand: macOS tap not started: {e}");
    }
}

/// macOS: classify a native key-down into a matcher `Key`.
#[cfg(target_os = "macos")]
fn classify_macos(ev: &crate::infrastructure::platform::macos_keytap::MacKeyEvent) -> Option<Key> {
    // Virtual keycodes (`kVK_*`).
    const BACKSPACE: u16 = 51;
    const RETURN: u16 = 36;
    const KP_ENTER: u16 = 76;
    const TAB: u16 = 48;
    const SPACE: u16 = 49;
    const ESCAPE: u16 = 53;
    const LEFT: u16 = 123;
    const RIGHT: u16 = 124;
    const DOWN: u16 = 125;
    const UP: u16 = 126;
    const HOME: u16 = 115;
    const END: u16 = 119;
    const PAGE_UP: u16 = 116;
    const PAGE_DOWN: u16 = 121;
    const FWD_DELETE: u16 = 117;

    match ev.keycode {
        BACKSPACE => Some(Key::Backspace),
        RETURN | KP_ENTER | TAB | SPACE => Some(Key::Delimiter),
        ESCAPE | LEFT | RIGHT | DOWN | UP | HOME | END | PAGE_UP | PAGE_DOWN | FWD_DELETE => Some(Key::Reset),
        _ => {
            // Cmd/Ctrl chord is a shortcut, not typing. Option (alternate) can
            // be part of typing a character on some layouts, so it's allowed.
            if ev.command || ev.control {
                return Some(Key::Reset);
            }
            ev.text.map(Key::Char)
        }
    }
}

/// Windows: install the low-level keyboard hook, handing each decoded key-down
/// to the matcher. The buffer lives in a `Mutex` because the hook handler is
/// `Fn` (called repeatedly on the hook's message-pump thread).
#[cfg(target_os = "windows")]
fn start_windows_tap(shared: Arc<Shared>, app: AppHandle) {
    use crate::infrastructure::platform::windows_keytap::{self, WinKeyEvent};

    let buffer = std::sync::Mutex::new(String::new());
    let seen_first = AtomicBool::new(false);
    let handler_app = app.clone();

    let handler = move |ev: WinKeyEvent| {
        if !seen_first.swap(true, Ordering::Relaxed) {
            log::info!("auto-expand: first keystroke event received — the tap is delivering");
        }
        if shared.expanding.load(Ordering::Relaxed) {
            return;
        }
        let Some(key) = classify_windows(&ev) else {
            return;
        };
        let mut buffer = buffer.lock().unwrap();
        process_and_fire(&shared, &handler_app, &mut buffer, key);
    };

    if let Err(e) = windows_keytap::start(Box::new(handler)) {
        log::warn!("auto-expand: Windows hook not started: {e}");
    }
}

/// Windows: classify a decoded key-down into a matcher `Key`.
#[cfg(target_os = "windows")]
fn classify_windows(ev: &crate::infrastructure::platform::windows_keytap::WinKeyEvent) -> Option<Key> {
    // Virtual-key codes (`VK_*`).
    const VK_BACK: u16 = 0x08;
    const VK_TAB: u16 = 0x09;
    const VK_RETURN: u16 = 0x0D;
    const VK_ESCAPE: u16 = 0x1B;
    const VK_SPACE: u16 = 0x20;
    const VK_PRIOR: u16 = 0x21; // Page Up
    const VK_NEXT: u16 = 0x22; // Page Down
    const VK_END: u16 = 0x23;
    const VK_HOME: u16 = 0x24;
    const VK_LEFT: u16 = 0x25;
    const VK_UP: u16 = 0x26;
    const VK_RIGHT: u16 = 0x27;
    const VK_DOWN: u16 = 0x28;
    const VK_DELETE: u16 = 0x2E;

    match ev.vk {
        VK_BACK => Some(Key::Backspace),
        VK_RETURN | VK_TAB | VK_SPACE => Some(Key::Delimiter),
        VK_ESCAPE | VK_LEFT | VK_UP | VK_RIGHT | VK_DOWN | VK_HOME | VK_END | VK_PRIOR | VK_NEXT | VK_DELETE => {
            Some(Key::Reset)
        }
        _ => {
            if ev.control {
                return Some(Key::Reset); // Ctrl chord (Alt-Gr can type, so allow Alt)
            }
            ev.text.map(Key::Char)
        }
    }
}

/// Linux/X11: install the XRecord tap, handing each decoded key press to the
/// matcher. The buffer lives in a `Mutex` because the handler is `Fn`.
#[cfg(target_os = "linux")]
fn start_linux_tap(shared: Arc<Shared>, app: AppHandle) {
    use crate::infrastructure::platform::linux_keytap::{self, LinuxKeyEvent};

    let buffer = std::sync::Mutex::new(String::new());
    let seen_first = AtomicBool::new(false);
    let handler_app = app.clone();

    let handler = move |ev: LinuxKeyEvent| {
        if !seen_first.swap(true, Ordering::Relaxed) {
            log::info!("auto-expand: first keystroke event received — the tap is delivering");
        }
        if shared.expanding.load(Ordering::Relaxed) {
            return;
        }
        let Some(key) = classify_linux(&ev) else {
            return;
        };
        let mut buffer = buffer.lock().unwrap();
        process_and_fire(&shared, &handler_app, &mut buffer, key);
    };

    if let Err(e) = linux_keytap::start(Box::new(handler)) {
        log::warn!("auto-expand: X11 tap not started: {e}");
    }
}

/// Linux/X11: classify a decoded key press (by its unshifted keysym) into a
/// matcher `Key`.
#[cfg(target_os = "linux")]
fn classify_linux(ev: &crate::infrastructure::platform::linux_keytap::LinuxKeyEvent) -> Option<Key> {
    // X11 keysyms (`XK_*`).
    const XK_BACKSPACE: u32 = 0xff08;
    const XK_TAB: u32 = 0xff09;
    const XK_RETURN: u32 = 0xff0d;
    const XK_KP_ENTER: u32 = 0xff8d;
    const XK_ESCAPE: u32 = 0xff1b;
    const XK_HOME: u32 = 0xff50;
    const XK_LEFT: u32 = 0xff51;
    const XK_UP: u32 = 0xff52;
    const XK_RIGHT: u32 = 0xff53;
    const XK_DOWN: u32 = 0xff54;
    const XK_PRIOR: u32 = 0xff55; // Page Up
    const XK_NEXT: u32 = 0xff56; // Page Down
    const XK_END: u32 = 0xff57;
    const XK_DELETE: u32 = 0xffff;
    const XK_SPACE: u32 = 0x0020;

    match ev.keysym {
        XK_BACKSPACE => Some(Key::Backspace),
        XK_RETURN | XK_KP_ENTER | XK_TAB | XK_SPACE => Some(Key::Delimiter),
        XK_ESCAPE | XK_LEFT | XK_UP | XK_RIGHT | XK_DOWN | XK_HOME | XK_END | XK_PRIOR | XK_NEXT | XK_DELETE => {
            Some(Key::Reset)
        }
        _ => {
            if ev.control {
                return Some(Key::Reset); // Ctrl chord
            }
            ev.text.map(Key::Char)
        }
    }
}

/// Resolves the snippet through the extension host, then does the in-place
/// insertion (delete keyword → paste expansion → restore clipboard → place
/// caret). Runs on a tokio worker; the blocking injection hops to the macOS
/// main thread internally, the same proven path the extension bridge's paste
/// handler uses.
async fn expand(app: &AppHandle, snippet_id: &str, backspaces: usize) -> Result<(), String> {
    let resolved = crate::application::extension_commands::resolve_snippet(app, snippet_id)
        .await
        .map_err(|e| e.to_string())?;

    let text = resolved.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if text.is_empty() {
        return Ok(());
    }
    let cursor_offset = resolved
        .get("cursorOffset")
        .and_then(|v| v.as_u64())
        .map(|n| n as usize)
        .unwrap_or_else(|| text.chars().count());

    let state = app.state::<AppState>();
    paste::expand_in_place(&text, cursor_offset, backspaces, |s| state.clipboard_watcher.suppress_text(s))?;
    Ok(())
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::db::SharedConnection;
    use rusqlite::Connection;
    use std::sync::{Arc, Mutex};

    fn entry(keyword: &str, id: &str) -> KeywordEntry {
        KeywordEntry { keyword: keyword.into(), snippet_id: id.into(), requires_argument: false }
    }

    fn run(keys: &[Key], keywords: &[KeywordEntry], mode: TriggerMode) -> Option<Match> {
        let mut buffer = String::new();
        let mut last = None;
        for &key in keys {
            last = process_key(&mut buffer, key, keywords, mode);
        }
        last
    }

    fn chars(s: &str) -> Vec<Key> {
        s.chars().map(Key::Char).collect()
    }

    #[test]
    fn instant_matches_when_buffer_ends_with_keyword() {
        let kws = vec![entry("sig", "s1")];
        let m = run(&chars("my sig"), &kws, TriggerMode::Instant);
        assert_eq!(m, Some(Match { snippet_id: "s1".into(), backspaces: 3 }));
    }

    #[test]
    fn instant_does_not_match_a_partial_keyword() {
        let kws = vec![entry("sig", "s1")];
        assert_eq!(run(&chars("si"), &kws, TriggerMode::Instant), None);
    }

    #[test]
    fn instant_does_not_fire_on_a_delimiter() {
        let kws = vec![entry("sig", "s1")];
        // "sig" already fired on the 'g'; a following space must not re-fire.
        let mut buffer = String::new();
        for &k in &chars("sig") {
            process_key(&mut buffer, k, &kws, TriggerMode::Instant);
        }
        assert_eq!(process_key(&mut buffer, Key::Delimiter, &kws, TriggerMode::Instant), None);
    }

    #[test]
    fn delimiter_matches_only_with_a_trailing_delimiter() {
        let kws = vec![entry("sig", "s1")];
        // typing the keyword alone does not fire in delimiter mode
        assert_eq!(run(&chars("sig"), &kws, TriggerMode::Delimiter), None);
        // the delimiter after it does, and deletes keyword + delimiter
        let mut keys = chars("sig");
        keys.push(Key::Delimiter);
        assert_eq!(run(&keys, &kws, TriggerMode::Delimiter), Some(Match { snippet_id: "s1".into(), backspaces: 4 }));
    }

    #[test]
    fn longest_keyword_wins_on_overlap() {
        let kws = vec![entry("sig", "short"), entry("assign", "long")];
        // buffer "assign" ends with both "sign"? no; ends with "assign" and not "sig".
        // Use a real overlap: "ig" suffix shared. Keywords "ig" and "sig".
        let kws2 = vec![entry("ig", "short"), entry("sig", "long")];
        let m = run(&chars("a sig"), &kws2, TriggerMode::Instant);
        assert_eq!(m, Some(Match { snippet_id: "long".into(), backspaces: 3 }));
        // silence unused-var style: assert the first set still parses
        assert_eq!(kws.len(), 2);
    }

    #[test]
    fn argument_taking_snippets_never_match() {
        let kws = vec![KeywordEntry { keyword: "sig".into(), snippet_id: "s1".into(), requires_argument: true }];
        assert_eq!(run(&chars("sig"), &kws, TriggerMode::Instant), None);
    }

    #[test]
    fn multibyte_keyword_backspaces_count_chars_not_bytes() {
        // "café" is 5 bytes, 4 chars; deletion must be 4 backspaces.
        let kws = vec![entry("café", "s1")];
        let m = run(&chars("café"), &kws, TriggerMode::Instant);
        assert_eq!(m, Some(Match { snippet_id: "s1".into(), backspaces: 4 }));
    }

    #[test]
    fn backspace_pops_and_reset_clears() {
        let kws = vec![entry("sig", "s1")];
        // type "six", backspace the 'x', type 'g' -> "sig" fires
        let keys = [Key::Char('s'), Key::Char('i'), Key::Char('x'), Key::Backspace, Key::Char('g')];
        assert_eq!(run(&keys, &kws, TriggerMode::Instant), Some(Match { snippet_id: "s1".into(), backspaces: 3 }));
        // a Reset mid-way abandons the buffer
        let keys2 = [Key::Char('s'), Key::Char('i'), Key::Reset, Key::Char('g')];
        assert_eq!(run(&keys2, &kws, TriggerMode::Instant), None);
    }

    fn seed_storage(rows: &[(&str, &str)]) -> ExtensionStorage {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE extension_storage (extension_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (extension_id, key));",
        )
        .unwrap();
        for (key, json) in rows {
            // Stored as a JSON *string*, exactly like a live JSON.stringify write.
            let quoted = serde_json::Value::String((*json).to_string()).to_string();
            conn.execute(
                "INSERT INTO extension_storage (extension_id, key, value) VALUES ('snippets', ?1, ?2)",
                rusqlite::params![key, quoted],
            )
            .unwrap();
        }
        let shared: SharedConnection = Arc::new(Mutex::new(conn));
        ExtensionStorage::new(shared)
    }

    #[test]
    fn load_keywords_returns_only_eligible_entries() {
        let storage = seed_storage(&[
            ("snippet.1", r#"{"id":"snippet.1","name":"Sig","keyword":"sig","body":"Best, me","createdAt":1}"#),
            ("snippet.2", r#"{"id":"snippet.2","name":"NoKw","body":"no keyword","createdAt":2}"#),
            ("snippet.3", r#"{"id":"snippet.3","name":"Arg","keyword":"greet","body":"Hi {argument}","createdAt":3}"#),
        ]);
        let mut entries = load_keywords(&storage);
        entries.sort_by(|a, b| a.snippet_id.cmp(&b.snippet_id));

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0], KeywordEntry { keyword: "sig".into(), snippet_id: "snippet.1".into(), requires_argument: false });
        assert_eq!(entries[1], KeywordEntry { keyword: "greet".into(), snippet_id: "snippet.3".into(), requires_argument: true });
    }

    #[test]
    fn load_keywords_skips_the_argument_snippet_in_matching() {
        let storage = seed_storage(&[
            ("snippet.3", r#"{"id":"snippet.3","name":"Arg","keyword":"greet","body":"Hi {argument}","createdAt":3}"#),
        ]);
        let kws = load_keywords(&storage);
        assert_eq!(run(&chars("greet"), &kws, TriggerMode::Instant), None);
    }
}
