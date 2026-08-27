//! Best-effort per-platform OCR, dispatched by target OS — the same shape
//! as `window_manage`/`window_list`/`menu_bar`. `available()` reports
//! whether this session can extract text at all (Linux: `tesseract` on
//! PATH; macOS: Vision always ships; Windows: depends on installed
//! language packs); `extract_text` degrades to `None` on any failure
//! rather than erroring, so a background OCR sweep never has to handle a
//! partial/error state beyond "nothing found this time".

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

use std::path::Path;

pub fn available() -> bool {
    #[cfg(target_os = "linux")]
    {
        linux::available()
    }
    #[cfg(target_os = "macos")]
    {
        macos::available()
    }
    #[cfg(target_os = "windows")]
    {
        windows::available()
    }
}

/// Human-readable engine name for the settings-pane status line. Only
/// meaningful when `available()` is true.
pub fn engine_name() -> &'static str {
    #[cfg(target_os = "linux")]
    {
        linux::engine_name()
    }
    #[cfg(target_os = "macos")]
    {
        macos::engine_name()
    }
    #[cfg(target_os = "windows")]
    {
        windows::engine_name()
    }
}

/// Best-effort text extraction. `None` covers every failure mode
/// (`available()` false, decode error, empty result, engine error) —
/// callers don't distinguish them, matching every other platform surface
/// in this codebase.
pub fn extract_text(path: &Path) -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        linux::extract_text(path)
    }
    #[cfg(target_os = "macos")]
    {
        macos::extract_text(path)
    }
    #[cfg(target_os = "windows")]
    {
        windows::extract_text(path)
    }
}
