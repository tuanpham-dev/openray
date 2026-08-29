use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    App,
};

use crate::infrastructure::window;

/// Explicit id so the "Show Tray Icon" setting can look this tray back up
/// via `app.tray_by_id(TRAY_ID)` and toggle its visibility at runtime —
/// `TrayIconBuilder::new()` (no id) leaves no way to address the tray
/// after `build()` returns.
pub const TRAY_ID: &str = "main";

pub fn build(app: &App) -> Result<(), Box<dyn std::error::Error>> {
    let toggle_item = MenuItem::with_id(app, "toggle", "Toggle OpenRay", true, None::<&str>)?;
    let settings_item = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&toggle_item, &settings_item, &quit_item])?;

    TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("OpenRay")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "toggle" => {
                let _ = window::toggle_palette(app);
            }
            "settings" => {
                let _ = window::open_settings_window(app, window::SettingsTarget::General);
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;

    Ok(())
}
