use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

use crate::infrastructure::window;

#[tauri::command]
pub fn hide_palette(app: AppHandle) -> Result<(), String> {
    window::hide_palette(&app).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_system_theme(app: AppHandle) -> String {
    window::system_theme(&app)
}

/// Opens `url` in the user's browser. Goes through the same opener the
/// quicklink provider uses rather than a frontend plugin, which keeps
/// URL-opening on one path and avoids granting the webview its own
/// shell/opener permission.
#[tauri::command]
pub fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

/// T24/T26: an extension window's own frontend calls this on Escape —
/// never Tauri's built-in `getCurrentWindow().close()`, which bypasses
/// `wake_main_loop()` entirely and left a closed-but-still-visible,
/// unresponsive window live on screen (found live, T26). See
/// `infrastructure::window::close_extension_window`'s doc comment.
#[tauri::command]
pub fn close_extension_window(app: AppHandle, window_label: String) -> Result<(), String> {
    window::close_extension_window(&app, &window_label).map_err(|e| e.to_string())
}
