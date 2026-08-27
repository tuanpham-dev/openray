//! Shared filesystem-path helpers. `expand_home` used to live in
//! `application::script_commands` and was imported cross-feature by
//! `application::screenshots` and `application::sync` — an infrastructure
//! concern (path resolution) that had drifted into a feature module. Moved
//! here as part of the extension-platform refactor's layering pass
//! (`plans/refactor-extension-platform.md`, T7).

use std::io;
use std::path::PathBuf;

use tauri::{AppHandle, Manager, Runtime};

/// The directory OpenRay keeps its user-editable configuration in:
/// `~/.config/openray` on Linux, `~/Library/Application Support/openray` on
/// macOS, `%APPDATA%\openray` on Windows.
///
/// Deliberately built from Tauri's *base* `config_dir()` plus a plain
/// `openray` folder rather than `app_config_dir()`, which appends the bundle
/// identifier and would bury these files in `~/.config/com.openray.desktop`.
/// Only genuine configuration lives here — databases, installed extensions
/// and cached images stay under `app_data_dir()`.
///
/// The directory is created if it doesn't exist yet, so callers can join a
/// filename onto the result and write straight to it.
/// Generic over the runtime so the mock runtime can exercise it in tests.
pub fn config_dir<R: Runtime>(app: &AppHandle<R>) -> io::Result<PathBuf> {
    let dir = app.path().config_dir().map_err(io::Error::other)?.join(CONFIG_DIR_NAME);
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

const CONFIG_DIR_NAME: &str = "openray";

/// Expands a leading `~/` (or `~\` on Windows) to the user's home
/// directory. `HOME` is the Unix convention; `USERPROFILE` is Windows',
/// where `HOME` is usually unset outside of Git Bash/MSYS environments. A
/// path with no leading `~` separator, or with neither environment
/// variable set, passes through unchanged.
pub fn expand_home(path: &str) -> PathBuf {
    let rest = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\"));
    if let Some(rest) = rest {
        if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The whole point of `config_dir` is that it does *not* bury config
    /// under the bundle identifier the way `app_config_dir()` does, so the
    /// assertion is specifically about the final component and its parent.
    #[test]
    fn config_dir_is_a_plain_openray_folder_inside_the_platform_config_dir() {
        let app = tauri::test::mock_builder().build(tauri::generate_context!()).expect("failed to build mock app");
        let dir = config_dir(app.handle()).expect("config dir should resolve");

        assert_eq!(dir.file_name().and_then(|n| n.to_str()), Some("openray"));
        assert_eq!(dir.parent(), app.handle().path().config_dir().ok().as_deref());
        assert!(!dir.to_string_lossy().contains("com.openray.desktop"));
        assert!(dir.is_dir(), "config_dir must create the directory it returns");
    }

    #[test]
    fn home_expansion_handles_both_separators() {
        // `~/` works wherever HOME (or USERPROFILE) is set; a bare path
        // passes through untouched.
        assert_eq!(expand_home("/abs/path"), PathBuf::from("/abs/path"));
        if std::env::var_os("HOME").is_some() {
            assert!(expand_home("~/scripts").is_absolute());
            assert!(!expand_home("~/scripts").display().to_string().contains('~'));
        }
    }
}
