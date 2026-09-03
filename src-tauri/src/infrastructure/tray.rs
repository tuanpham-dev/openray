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

    let builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip("OpenRay");

    // macOS menu bars want a monochrome *template* image — a black glyph
    // whose alpha the system recolours for a light or dark bar — not the
    // coloured app tile, which reads as a sticker next to Apple's own
    // items. `tray@2x.png` (72px) scales to the bar's 18pt slot on Retina
    // without going soft. Other platforms keep the app icon: their trays
    // don't recolour a template, so a fixed black glyph would vanish on a
    // dark taskbar.
    #[cfg(target_os = "macos")]
    let builder = builder
        .icon(tauri::include_image!("./icons/tray@2x.png"))
        .icon_as_template(true);
    #[cfg(not(target_os = "macos"))]
    let builder = builder.icon(app.default_window_icon().unwrap().clone());

    builder
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
