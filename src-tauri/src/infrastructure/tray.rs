use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    App, AppHandle,
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

    // A tray wants a monochrome glyph, not the coloured app tile, which
    // reads as a sticker next to the system's own status items.
    //
    // macOS takes the black glyph as a *template* image and recolours it
    // from the alpha channel for a light or dark bar, dimming it when the
    // item is disabled. `tray@2x.png` (72px) scales to the bar's 18pt slot
    // on Retina without going soft.
    #[cfg(target_os = "macos")]
    let builder = builder
        .icon(tauri::include_image!("./icons/tray@2x.png"))
        .icon_as_template(true);

    // Every other tray draws the bitmap as handed over, so the glyph has to
    // be chosen for the panel rather than recoloured by it: black on a light
    // panel, white on a dark one. The desktop theme is the best signal we
    // have for which — the XFCE/GNOME panel follows it — and it can change
    // while the app runs, so `apply_system_theme` re-picks on the same
    // `ThemeChanged` event the palette repaints on.
    #[cfg(not(target_os = "macos"))]
    let builder = builder.icon(glyph_for_theme(&window::system_theme(app.handle())));

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

/// The glyph that reads against a panel of the given desktop theme
/// (`window::system_theme`'s `"dark"` / `"light"`).
#[cfg(not(target_os = "macos"))]
fn glyph_for_theme(theme: &str) -> tauri::image::Image<'static> {
    if theme == "dark" {
        tauri::include_image!("./icons/tray-inverted@2x.png")
    } else {
        tauri::include_image!("./icons/tray@2x.png")
    }
}

/// Repaints the tray glyph for the current desktop theme. Called whenever
/// the theme changes, since the icon was picked to suit the panel it was
/// sitting on and that panel has just been repainted.
///
/// macOS needs none of this: its template image is recoloured by the system,
/// so the glyph it was given at build time stays correct.
#[cfg(not(target_os = "macos"))]
pub fn apply_system_theme(app: &AppHandle) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_icon(Some(glyph_for_theme(&window::system_theme(app))));
    }
}

#[cfg(target_os = "macos")]
pub fn apply_system_theme(_app: &AppHandle) {}
