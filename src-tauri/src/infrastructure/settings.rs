use std::fs;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::error::Error;

const SETTINGS_FILE: &str = "settings.json";
const SETTINGS_CHANGED_EVENT: &str = "settings-changed";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub hotkey: String,
    pub theme: String,
    pub launch_at_login: bool,
    #[serde(default = "default_window_size")]
    pub window_size: String,
    /// Palette background opacity, 0.3–1.0. `serde(default)` matters here:
    /// settings.json files written before this field existed must keep
    /// loading rather than falling back to `Settings::default()` wholesale
    /// (which would silently reset the user's hotkey and theme too).
    #[serde(default = "default_opacity")]
    pub opacity: f64,
    #[serde(default = "default_shadow")]
    pub shadow: bool,
    /// Vim-style Alt+J / Alt+K as an alternative to the arrow keys for
    /// moving through lists.
    #[serde(default = "default_alt_jk_navigation")]
    pub alt_jk_navigation: bool,
    /// Directories scanned for Raycast-style script commands (T20:
    /// `extensions/script-commands`, read live via
    /// `host.system.getScriptDirectories`). `~/` is expanded at scan time.
    #[serde(default)]
    pub script_directories: Vec<String>,
    /// Pixel gap Window Management's tiling presets and Maximize leave
    /// around and between windows. 0–64, clamped by `clamp_window_gap`.
    #[serde(default = "default_window_gap")]
    pub window_gap: u32,
    /// Whether repeatedly pressing the same Half preset cycles the
    /// window's size through ½ → ⅔ → ⅓ instead of repeating the same size.
    #[serde(default = "default_half_cycling")]
    pub half_cycling: bool,
    /// Folders Screenshots scans for images/videos. `~/` is expanded at
    /// scan time, same convention as `script_directories`.
    #[serde(default = "default_screenshot_search_scopes")]
    pub screenshot_search_scopes: Vec<String>,
    /// File extensions (no leading dot) Screenshots treats as video —
    /// shown in the grid but never pasted/copied/OCR'd.
    #[serde(default = "default_screenshot_video_extensions")]
    pub screenshot_video_extensions: Vec<String>,
    /// Grid column count, 3–6, clamped by `clamp_screenshot_grid_columns`.
    #[serde(default = "default_screenshot_grid_columns")]
    pub screenshot_grid_columns: u32,
    /// Whether the background OCR sweep runs at all. Off leaves any
    /// already-indexed text alone (just unused) — turning it back on
    /// resumes indexing immediately, nothing needs re-scanning from
    /// scratch.
    #[serde(default = "default_screenshot_ocr_enabled")]
    pub screenshot_ocr_enabled: bool,
    /// What Paste/Copy put on the clipboard by default — `"auto"` (image
    /// pixels, a file reference, and the plain path all offered at once,
    /// so whichever a paste target understands, it gets something
    /// useful), `"image"` (decoded pixels only), `"file"` (a
    /// `text/uri-list` file reference, works for videos too), or
    /// `"path"` (the plain path string only). Clamped to one of those
    /// four by `clamp_screenshot_paste_format`. The grid's action panel
    /// can still override this per-action regardless of the default.
    #[serde(default = "default_screenshot_paste_format")]
    pub screenshot_paste_format: String,
    /// Remembered target language for the Translate view — also its
    /// default on next open. A gtx language code (see
    /// `application::translate::languages`).
    #[serde(default = "default_translate_target_language")]
    pub translate_target_language: String,
    /// Default source language for the Translate view — `"auto"` (detect)
    /// or a gtx language code.
    #[serde(default = "default_translate_source_language")]
    pub translate_source_language: String,
    /// What Translate's primary action (↵) does with the translated text —
    /// `"copy"` or `"paste"`. Clamped to one of those two by
    /// `clamp_translate_primary_action`.
    #[serde(default = "default_translate_primary_action")]
    pub translate_primary_action: String,
    /// Whether translations are recorded to `translate_history`. Off
    /// leaves any already-recorded history alone (just unused) — matches
    /// `screenshot_ocr_enabled`'s convention.
    #[serde(default = "default_translate_history_enabled")]
    pub translate_history_enabled: bool,
    /// Whether the notes window stays above other windows.
    #[serde(default = "default_notes_always_on_top")]
    pub notes_always_on_top: bool,
    /// Default chat model, `<provider>:<model>` (see
    /// `application::ai::providers::split_model_id`).
    #[serde(default = "default_ai_model")]
    pub ai_default_model: String,
    /// Quick AI's model — empty string means "follow `ai_default_model`".
    #[serde(default)]
    pub ai_quick_model: String,
    /// Personalization profile text, prepended to every chat's system
    /// prompt (`application::ai::engine::build_system_prompt`).
    #[serde(default)]
    pub ai_profile: String,
    /// Directories scanned (top level only) for `SKILL.md` files.
    #[serde(default = "default_ai_skill_dirs")]
    pub ai_skill_dirs: Vec<String>,
    /// User-defined `cli:custom:<name>` presets — see the `ai` extension's
    /// `src/providers/cli.ts` (T27; this field is read live via
    /// `host.ai.getSettings`, same as the other `ai_*` fields above).
    #[serde(default)]
    pub ai_custom_clis: Vec<AiCustomCli>,
    /// How long after the palette is hidden its query/view/selection reset
    /// back to root search on next show — `"never"`, `"immediately"`, or a
    /// delay in seconds as a string (`"10"`..`"180"`). Clamped to one of
    /// those by `clamp_pop_to_root_delay`.
    #[serde(default = "default_pop_to_root_delay")]
    pub pop_to_root_delay: String,
    /// How aggressively root search filters out weak fuzzy matches —
    /// `"low"` (today's behavior: any subsequence match survives),
    /// `"medium"`, or `"high"`. Clamped to one of those three by
    /// `clamp_search_sensitivity`.
    #[serde(default = "default_search_sensitivity")]
    pub search_sensitivity: String,
    /// Palette text scale — `"default"`, `"large"`, or `"larger"`. Clamped
    /// to one of those three by `clamp_text_size`.
    #[serde(default = "default_text_size")]
    pub text_size: String,
    /// Whether the tray icon is shown at all.
    #[serde(default = "default_show_tray_icon")]
    pub show_tray_icon: bool,
    /// Which screen the palette opens centered on — `"cursor"` (the
    /// monitor under the pointer) or `"primary"`. Clamped to one of those
    /// two by `clamp_show_on_screen`.
    #[serde(default = "default_show_on_screen")]
    pub show_on_screen: String,
    /// Clipboard history row cap, 100–10000, clamped by
    /// `clamp_clipboard_max_entries`.
    #[serde(default = "default_clipboard_max_entries")]
    pub clipboard_max_entries: u32,
    /// Clipboard history per-image size cap in MB, 4–256, clamped by
    /// `clamp_clipboard_max_image_mb`.
    #[serde(default = "default_clipboard_max_image_mb")]
    pub clipboard_max_image_mb: u32,
    /// How long a clipboard history entry is kept before it's pruned,
    /// alongside (not instead of) `clipboard_max_entries` — whichever
    /// limit is more restrictive prunes further. `"never"` or a day-count
    /// string (`"1"`..`"365"`). Clamped by `clamp_clipboard_retention_days`.
    #[serde(default = "default_clipboard_retention_days")]
    pub clipboard_retention_days: String,
    /// Directories scanned for File Search results. `~/` is expanded at
    /// scan time, same convention as `script_directories`. Empty means the
    /// feature contributes no root-search row at all.
    #[serde(default)]
    pub file_search_scopes: Vec<String>,
    /// How long a screenshot file is kept before the background sweep
    /// moves it to the OS trash (never permanently deleted). `"unlimited"`
    /// (default, i.e. off) or a day-count string (`"1"`..`"365"`). Pinned
    /// screenshots (`screenshot_pins` table) are always exempt. Clamped by
    /// `clamp_screenshot_storage_duration`.
    #[serde(default = "default_screenshot_storage_duration")]
    pub screenshot_storage_duration: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCustomCli {
    pub name: String,
    /// Argv template — one element must contain the literal `{prompt}`
    /// placeholder.
    pub command: Vec<String>,
}

fn default_window_size() -> String {
    "medium".into()
}

fn default_opacity() -> f64 {
    0.85
}

fn default_shadow() -> bool {
    true
}

fn default_alt_jk_navigation() -> bool {
    true
}

fn default_window_gap() -> u32 {
    0
}

fn default_half_cycling() -> bool {
    true
}

/// Per-OS default screenshot folder — mirrors `default_hotkey()`'s
/// per-platform pattern. Stored unexpanded (`~/...`), same convention as
/// `script_directories`; expansion happens at scan time.
fn default_screenshot_search_scopes() -> Vec<String> {
    if cfg!(target_os = "macos") {
        vec!["~/Desktop".into()]
    } else {
        // Windows' Snipping Tool/Win+PrtScn default and the Linux XDG/
        // GNOME/KDE convention are the same relative path; `~/` expands
        // to `%USERPROFILE%` on Windows and `$HOME` on Linux via the
        // shared `expand_home` helper (`infrastructure::paths`).
        vec!["~/Pictures/Screenshots".into()]
    }
}

fn default_screenshot_video_extensions() -> Vec<String> {
    vec!["mp4".into(), "mov".into(), "webm".into()]
}

fn default_screenshot_grid_columns() -> u32 {
    4
}

fn default_screenshot_ocr_enabled() -> bool {
    true
}

fn default_screenshot_paste_format() -> String {
    "auto".into()
}

fn default_translate_target_language() -> String {
    "en".into()
}

fn default_translate_source_language() -> String {
    "auto".into()
}

fn default_translate_primary_action() -> String {
    "copy".into()
}

fn default_translate_history_enabled() -> bool {
    true
}

fn default_notes_always_on_top() -> bool {
    false
}

fn default_ai_model() -> String {
    "anthropic:claude-sonnet-5".into()
}

fn default_ai_skill_dirs() -> Vec<String> {
    vec!["~/.claude/skills".into(), "~/.config/openray/skills".into()]
}

fn default_pop_to_root_delay() -> String {
    "never".into()
}

fn default_search_sensitivity() -> String {
    "low".into()
}

fn default_text_size() -> String {
    "default".into()
}

fn default_show_tray_icon() -> bool {
    true
}

fn default_show_on_screen() -> String {
    "cursor".into()
}

fn default_clipboard_max_entries() -> u32 {
    1000
}

fn default_clipboard_max_image_mb() -> u32 {
    64
}

fn default_clipboard_retention_days() -> String {
    "never".into()
}

fn default_screenshot_storage_duration() -> String {
    "unlimited".into()
}

const RETENTION_DAY_TIERS: &[&str] = &["1", "7", "30", "90", "180", "365"];

/// Keeps a hand-edited config or bad IPC payload from setting an
/// unrecognized primary action — falls back to `"copy"`, the default.
pub fn clamp_translate_primary_action(action: String) -> String {
    match action.as_str() {
        "copy" | "paste" => action,
        _ => default_translate_primary_action(),
    }
}

/// Keeps a hand-edited config or bad IPC payload from setting an
/// unrecognized paste format — falls back to `"auto"`, the default.
pub fn clamp_screenshot_paste_format(format: String) -> String {
    match format.as_str() {
        "auto" | "image" | "file" | "path" => format,
        _ => default_screenshot_paste_format(),
    }
}

/// Keeps a hand-edited config or bad IPC payload from setting a grid too
/// narrow to be useful or too wide to see thumbnails at.
pub fn clamp_screenshot_grid_columns(columns: u32) -> u32 {
    columns.clamp(3, 6)
}

/// Keeps a hand-edited config or bad IPC payload from setting a gap wide
/// enough to squeeze tiled windows down to nothing.
pub fn clamp_window_gap(gap: u32) -> u32 {
    gap.min(64)
}

/// Keeps the palette from being made invisible (or fully opaque past the
/// point the blur/translucency design assumes) by a hand-edited config or
/// a bad IPC payload.
pub fn clamp_opacity(opacity: f64) -> f64 {
    if opacity.is_nan() {
        return default_opacity();
    }
    opacity.clamp(0.3, 1.0)
}

/// Keeps a hand-edited config or bad IPC payload from setting an
/// unrecognized pop-to-root delay — falls back to `"never"`, the default.
pub fn clamp_pop_to_root_delay(delay: String) -> String {
    match delay.as_str() {
        "never" | "immediately" | "10" | "30" | "60" | "90" | "180" => delay,
        _ => default_pop_to_root_delay(),
    }
}

/// Keeps a hand-edited config or bad IPC payload from setting an
/// unrecognized sensitivity — falls back to `"low"`, the default.
pub fn clamp_search_sensitivity(sensitivity: String) -> String {
    match sensitivity.as_str() {
        "low" | "medium" | "high" => sensitivity,
        _ => default_search_sensitivity(),
    }
}

/// Keeps a hand-edited config or bad IPC payload from setting an
/// unrecognized text size — falls back to `"default"`, the default.
pub fn clamp_text_size(size: String) -> String {
    match size.as_str() {
        "default" | "large" | "larger" => size,
        _ => default_text_size(),
    }
}

/// Keeps a hand-edited config or bad IPC payload from setting an
/// unrecognized screen choice — falls back to `"cursor"`, the default.
pub fn clamp_show_on_screen(screen: String) -> String {
    match screen.as_str() {
        "cursor" | "primary" => screen,
        _ => default_show_on_screen(),
    }
}

/// Keeps a hand-edited config or bad IPC payload from setting a clipboard
/// history cap too small to be useful or large enough to bloat the DB.
pub fn clamp_clipboard_max_entries(entries: u32) -> u32 {
    entries.clamp(100, 10000)
}

/// Keeps a hand-edited config or bad IPC payload from setting an image
/// size cap too small to keep real screenshots or large enough to stall
/// the watcher on huge files.
pub fn clamp_clipboard_max_image_mb(mb: u32) -> u32 {
    mb.clamp(4, 256)
}

/// Keeps a hand-edited config or bad IPC payload from setting an
/// unrecognized retention tier — falls back to `"never"`, the default.
pub fn clamp_clipboard_retention_days(days: String) -> String {
    if days == "never" || RETENTION_DAY_TIERS.contains(&days.as_str()) {
        days
    } else {
        default_clipboard_retention_days()
    }
}

/// Keeps a hand-edited config or bad IPC payload from setting an
/// unrecognized storage-duration tier — falls back to `"unlimited"`, the
/// default.
pub fn clamp_screenshot_storage_duration(duration: String) -> String {
    if duration == "unlimited" || RETENTION_DAY_TIERS.contains(&duration.as_str()) {
        duration
    } else {
        default_screenshot_storage_duration()
    }
}

/// "Cmd" only means "the Mac modifier key" — on Windows/Linux it parses as
/// the Windows/Super key, which isn't the convention this kind of launcher
/// uses there. Match Raycast's own per-platform default instead of picking
/// one binding for every OS.
fn default_hotkey() -> String {
    if cfg!(target_os = "macos") {
        "Cmd+Space".into()
    } else {
        "Alt+Space".into()
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            hotkey: default_hotkey(),
            theme: "system".into(),
            launch_at_login: false,
            window_size: default_window_size(),
            opacity: default_opacity(),
            shadow: default_shadow(),
            alt_jk_navigation: default_alt_jk_navigation(),
            script_directories: Vec::new(),
            window_gap: default_window_gap(),
            half_cycling: default_half_cycling(),
            screenshot_search_scopes: default_screenshot_search_scopes(),
            screenshot_video_extensions: default_screenshot_video_extensions(),
            screenshot_grid_columns: default_screenshot_grid_columns(),
            screenshot_ocr_enabled: default_screenshot_ocr_enabled(),
            screenshot_paste_format: default_screenshot_paste_format(),
            translate_target_language: default_translate_target_language(),
            translate_source_language: default_translate_source_language(),
            translate_primary_action: default_translate_primary_action(),
            translate_history_enabled: default_translate_history_enabled(),
            notes_always_on_top: default_notes_always_on_top(),
            ai_default_model: default_ai_model(),
            ai_quick_model: String::new(),
            ai_profile: String::new(),
            ai_skill_dirs: default_ai_skill_dirs(),
            ai_custom_clis: Vec::new(),
            pop_to_root_delay: default_pop_to_root_delay(),
            search_sensitivity: default_search_sensitivity(),
            text_size: default_text_size(),
            show_tray_icon: default_show_tray_icon(),
            show_on_screen: default_show_on_screen(),
            clipboard_max_entries: default_clipboard_max_entries(),
            clipboard_max_image_mb: default_clipboard_max_image_mb(),
            clipboard_retention_days: default_clipboard_retention_days(),
            file_search_scopes: Vec::new(),
            screenshot_storage_duration: default_screenshot_storage_duration(),
        }
    }
}

pub struct SettingsStore {
    app: AppHandle,
    path: PathBuf,
    current: RwLock<Settings>,
}

/// Clamps every out-of-range field in place. Applied inside
/// [`SettingsStore::update`] so *every* writer is covered — notably
/// `application::transfer::apply_portable_settings`, which applies an
/// imported file's settings directly and would otherwise bypass the
/// clamps that only lived in the `update_settings` Tauri command.
fn clamp_settings(settings: &mut Settings) {
    settings.opacity = clamp_opacity(settings.opacity);
    settings.window_gap = clamp_window_gap(settings.window_gap);
    settings.screenshot_grid_columns = clamp_screenshot_grid_columns(settings.screenshot_grid_columns);
    settings.screenshot_paste_format = clamp_screenshot_paste_format(settings.screenshot_paste_format.clone());
    settings.translate_primary_action = clamp_translate_primary_action(settings.translate_primary_action.clone());
    settings.pop_to_root_delay = clamp_pop_to_root_delay(settings.pop_to_root_delay.clone());
    settings.search_sensitivity = clamp_search_sensitivity(settings.search_sensitivity.clone());
    settings.text_size = clamp_text_size(settings.text_size.clone());
    settings.show_on_screen = clamp_show_on_screen(settings.show_on_screen.clone());
    settings.clipboard_max_entries = clamp_clipboard_max_entries(settings.clipboard_max_entries);
    settings.clipboard_max_image_mb = clamp_clipboard_max_image_mb(settings.clipboard_max_image_mb);
    settings.clipboard_retention_days = clamp_clipboard_retention_days(settings.clipboard_retention_days.clone());
    settings.screenshot_storage_duration = clamp_screenshot_storage_duration(settings.screenshot_storage_duration.clone());
}

/// Reads `settings.json` at `path`, tolerating both a missing file (fresh
/// install) and an unparseable one. A parse failure would otherwise
/// silently reset every setting to default — and an export taken
/// afterwards would then carry that reset onward to another machine. So
/// the unreadable file is preserved alongside it as
/// `settings.json.bak` for recovery/debugging before falling back
/// (best-effort: a failed backup write must not block startup).
fn load_settings_from(path: &Path) -> Settings {
    let Ok(contents) = fs::read_to_string(path) else {
        return Settings::default();
    };
    match serde_json::from_str(&contents) {
        Ok(settings) => settings,
        Err(_) => {
            let _ = fs::write(path.with_extension("json.bak"), &contents);
            Settings::default()
        }
    }
}

/// Writes `settings.json` via temp-file + rename so a reader (or a
/// concurrent sync cycle) never observes a partially-written file.
fn write_settings_atomic(path: &Path, settings: &Settings) -> Result<(), Error> {
    let json = serde_json::to_string_pretty(settings)?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

impl SettingsStore {
    pub fn load(app: AppHandle) -> Result<Self, Box<dyn std::error::Error>> {
        let config_dir = crate::infrastructure::paths::config_dir(&app)?;
        let path = config_dir.join(SETTINGS_FILE);
        let current = if path.exists() { load_settings_from(&path) } else { Settings::default() };

        Ok(Self { app, path, current: RwLock::new(current) })
    }

    pub fn get(&self) -> Settings {
        self.current.read().unwrap().clone()
    }

    pub fn update(&self, mut settings: Settings) -> Result<(), Error> {
        clamp_settings(&mut settings);

        {
            let mut current = self.current.write().unwrap();
            *current = settings.clone();
        }

        write_settings_atomic(&self.path, &settings)?;
        let _ = self.app.emit(SETTINGS_CHANGED_EVENT, &settings);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_settings_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("openray-settings-test-{name}-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        dir.join(SETTINGS_FILE)
    }

    #[test]
    fn clamp_settings_bounds_every_clamped_field() {
        let mut settings = Settings { opacity: 5.0, window_gap: 1000, screenshot_grid_columns: 99, ..Settings::default() };
        clamp_settings(&mut settings);
        assert_eq!(settings.opacity, 1.0);
        assert_eq!(settings.window_gap, 64);
        assert_eq!(settings.screenshot_grid_columns, 6);
    }

    #[test]
    fn load_settings_from_a_corrupt_file_preserves_it_as_bak_and_falls_back_to_default() {
        let path = test_settings_path("corrupt-preserves-bak");
        let _ = fs::remove_file(path.with_extension("json.bak"));
        fs::write(&path, "{ this is not valid json").unwrap();

        let loaded = load_settings_from(&path);

        assert_eq!(loaded.hotkey, Settings::default().hotkey);
        let backup = fs::read_to_string(path.with_extension("json.bak")).unwrap();
        assert_eq!(backup, "{ this is not valid json");
    }

    #[test]
    fn load_settings_from_a_missing_file_returns_default_with_no_backup() {
        let path = test_settings_path("missing-file-no-backup");
        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(path.with_extension("json.bak"));

        let loaded = load_settings_from(&path);

        assert_eq!(loaded.hotkey, Settings::default().hotkey);
        assert!(!path.with_extension("json.bak").exists());
    }

    #[test]
    fn write_settings_atomic_leaves_no_temp_file_and_content_round_trips() {
        let path = test_settings_path("atomic-write-roundtrip");
        let settings = Settings { hotkey: "Ctrl+Shift+Space".into(), ..Settings::default() };

        write_settings_atomic(&path, &settings).unwrap();

        assert!(!path.with_extension("json.tmp").exists());
        let reloaded = load_settings_from(&path);
        assert_eq!(reloaded.hotkey, "Ctrl+Shift+Space");
    }

    #[test]
    fn default_hotkey_matches_this_platform_convention() {
        let expected = if cfg!(target_os = "macos") { "Cmd+Space" } else { "Alt+Space" };
        assert_eq!(default_hotkey(), expected);
    }

    #[test]
    fn settings_written_before_opacity_and_shadow_existed_still_load() {
        let legacy = r#"{"hotkey":"Ctrl+Space","theme":"dark","launchAtLogin":true,"windowSize":"large"}"#;
        let settings: Settings = serde_json::from_str(legacy).unwrap();

        assert_eq!(settings.hotkey, "Ctrl+Space");
        assert_eq!(settings.theme, "dark");
        assert!(settings.launch_at_login);
        assert_eq!(settings.window_size, "large");
        assert_eq!(settings.opacity, default_opacity());
        assert!(settings.shadow);
        assert!(settings.alt_jk_navigation);
        assert_eq!(settings.window_gap, default_window_gap());
        assert!(settings.half_cycling);
        assert_eq!(settings.screenshot_search_scopes, default_screenshot_search_scopes());
        assert_eq!(settings.screenshot_video_extensions, default_screenshot_video_extensions());
        assert_eq!(settings.screenshot_grid_columns, default_screenshot_grid_columns());
        assert!(settings.screenshot_ocr_enabled);
        assert_eq!(settings.screenshot_paste_format, "auto");
        assert_eq!(settings.translate_target_language, default_translate_target_language());
        assert_eq!(settings.translate_source_language, default_translate_source_language());
        assert_eq!(settings.translate_primary_action, "copy");
        assert!(settings.translate_history_enabled);
        assert!(!settings.notes_always_on_top);
        assert_eq!(settings.pop_to_root_delay, default_pop_to_root_delay());
        assert_eq!(settings.search_sensitivity, default_search_sensitivity());
        assert_eq!(settings.text_size, default_text_size());
        assert!(settings.show_tray_icon);
        assert_eq!(settings.show_on_screen, default_show_on_screen());
        assert_eq!(settings.clipboard_max_entries, default_clipboard_max_entries());
        assert_eq!(settings.clipboard_max_image_mb, default_clipboard_max_image_mb());
        assert_eq!(settings.clipboard_retention_days, default_clipboard_retention_days());
        assert!(settings.file_search_scopes.is_empty());
        assert_eq!(settings.screenshot_storage_duration, default_screenshot_storage_duration());
    }

    #[test]
    fn clamp_pop_to_root_delay_accepts_known_values_and_falls_back_to_never() {
        for valid in ["never", "immediately", "10", "30", "60", "90", "180"] {
            assert_eq!(clamp_pop_to_root_delay(valid.into()), valid);
        }
        assert_eq!(clamp_pop_to_root_delay("bogus".into()), "never");
    }

    #[test]
    fn clamp_search_sensitivity_accepts_known_values_and_falls_back_to_low() {
        for valid in ["low", "medium", "high"] {
            assert_eq!(clamp_search_sensitivity(valid.into()), valid);
        }
        assert_eq!(clamp_search_sensitivity("bogus".into()), "low");
    }

    #[test]
    fn clamp_text_size_accepts_known_values_and_falls_back_to_default() {
        for valid in ["default", "large", "larger"] {
            assert_eq!(clamp_text_size(valid.into()), valid);
        }
        assert_eq!(clamp_text_size("bogus".into()), "default");
    }

    #[test]
    fn clamp_show_on_screen_accepts_known_values_and_falls_back_to_cursor() {
        assert_eq!(clamp_show_on_screen("cursor".into()), "cursor");
        assert_eq!(clamp_show_on_screen("primary".into()), "primary");
        assert_eq!(clamp_show_on_screen("bogus".into()), "cursor");
    }

    #[test]
    fn clamp_clipboard_max_entries_bounds_between_100_and_10000() {
        assert_eq!(clamp_clipboard_max_entries(1), 100);
        assert_eq!(clamp_clipboard_max_entries(1000), 1000);
        assert_eq!(clamp_clipboard_max_entries(999_999), 10000);
    }

    #[test]
    fn clamp_clipboard_max_image_mb_bounds_between_4_and_256() {
        assert_eq!(clamp_clipboard_max_image_mb(1), 4);
        assert_eq!(clamp_clipboard_max_image_mb(64), 64);
        assert_eq!(clamp_clipboard_max_image_mb(9999), 256);
    }

    #[test]
    fn clamp_clipboard_retention_days_accepts_known_values_and_falls_back_to_never() {
        for valid in ["never", "1", "7", "30", "90", "180", "365"] {
            assert_eq!(clamp_clipboard_retention_days(valid.into()), valid);
        }
        assert_eq!(clamp_clipboard_retention_days("bogus".into()), "never");
    }

    #[test]
    fn clamp_screenshot_storage_duration_accepts_known_values_and_falls_back_to_unlimited() {
        for valid in ["unlimited", "1", "7", "30", "90", "180", "365"] {
            assert_eq!(clamp_screenshot_storage_duration(valid.into()), valid);
        }
        assert_eq!(clamp_screenshot_storage_duration("bogus".into()), "unlimited");
    }

    #[test]
    fn clamp_translate_primary_action_accepts_known_values_and_falls_back_to_copy() {
        assert_eq!(clamp_translate_primary_action("copy".into()), "copy");
        assert_eq!(clamp_translate_primary_action("paste".into()), "paste");
        assert_eq!(clamp_translate_primary_action("bogus".into()), "copy");
        assert_eq!(clamp_translate_primary_action("".into()), "copy");
    }

    #[test]
    fn clamp_screenshot_grid_columns_bounds_between_three_and_six() {
        assert_eq!(clamp_screenshot_grid_columns(1), 3);
        assert_eq!(clamp_screenshot_grid_columns(4), 4);
        assert_eq!(clamp_screenshot_grid_columns(10), 6);
    }

    #[test]
    fn clamp_screenshot_paste_format_accepts_known_values_and_falls_back_to_auto() {
        assert_eq!(clamp_screenshot_paste_format("auto".into()), "auto");
        assert_eq!(clamp_screenshot_paste_format("image".into()), "image");
        assert_eq!(clamp_screenshot_paste_format("file".into()), "file");
        assert_eq!(clamp_screenshot_paste_format("path".into()), "path");
        assert_eq!(clamp_screenshot_paste_format("bogus".into()), "auto");
        assert_eq!(clamp_screenshot_paste_format("".into()), "auto");
    }

    #[test]
    fn default_screenshot_search_scopes_matches_this_platform_convention() {
        let expected = if cfg!(target_os = "macos") { vec!["~/Desktop"] } else { vec!["~/Pictures/Screenshots"] };
        assert_eq!(default_screenshot_search_scopes(), expected);
    }

    #[test]
    fn clamp_opacity_bounds_and_rejects_nan() {
        assert_eq!(clamp_opacity(0.85), 0.85);
        assert_eq!(clamp_opacity(0.0), 0.3);
        assert_eq!(clamp_opacity(2.0), 1.0);
        assert_eq!(clamp_opacity(f64::NAN), default_opacity());
    }

    #[test]
    fn clamp_window_gap_bounds_at_sixty_four() {
        assert_eq!(clamp_window_gap(16), 16);
        assert_eq!(clamp_window_gap(1000), 64);
        assert_eq!(clamp_window_gap(0), 0);
    }
}
