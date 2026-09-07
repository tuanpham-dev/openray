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
    // panel, white on a dark one — see `panel_theme` for which signal says
    // so. It can change while the app runs, so `apply_system_theme`
    // re-picks on the same `ThemeChanged` event the palette repaints on.
    #[cfg(not(target_os = "macos"))]
    let builder = {
        let theme = panel_theme(app.handle());
        log::info!("tray: {theme} panel, picking the matching glyph");
        builder.icon(glyph_for_theme(&theme))
    };

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

/// The glyph that reads against a panel of the given theme
/// (`panel_theme`'s `"dark"` / `"light"`).
#[cfg(not(target_os = "macos"))]
fn glyph_for_theme(theme: &str) -> tauri::image::Image<'static> {
    if theme == "dark" {
        tauri::include_image!("./icons/tray-inverted@2x.png")
    } else {
        tauri::include_image!("./icons/tray@2x.png")
    }
}

/// The theme of the panel the tray sits in — what the glyph has to read
/// against — as `"dark"` / `"light"`.
///
/// On Windows that is deliberately *not* what `window::system_theme`
/// reports. Windows keeps two settings under Personalize: `AppsUseLightTheme`,
/// which tao's theme API (and so the palette) follows, and
/// `SystemUsesLightTheme`, which the taskbar and notification area follow —
/// and the common configuration splits them, light apps over a dark
/// taskbar. Picking by the apps value there chose the black glyph for a
/// dark tray, where it vanished. Found live on exactly such a machine.
///
/// Falls back to the apps theme where the taskbar value isn't available,
/// which is also the right answer for the Linux panels that genuinely
/// follow the desktop theme.
#[cfg(not(target_os = "macos"))]
fn panel_theme(app: &AppHandle) -> String {
    taskbar_theme().map(str::to_string).unwrap_or_else(|| window::system_theme(app))
}

#[cfg(target_os = "windows")]
fn taskbar_theme() -> Option<&'static str> {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    let personalize = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize")
        .ok()?;
    let light: u32 = personalize.get_value("SystemUsesLightTheme").ok()?;
    Some(theme_for_light_flag(light))
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn taskbar_theme() -> Option<&'static str> {
    None
}

/// `SystemUsesLightTheme` is a DWORD flag: 0 is a dark taskbar, anything
/// else light.
#[cfg(not(target_os = "macos"))]
fn theme_for_light_flag(light: u32) -> &'static str {
    if light == 0 {
        "dark"
    } else {
        "light"
    }
}

/// Repaints the tray glyph for the current panel theme. Called whenever
/// the theme changes, since the icon was picked to suit the panel it was
/// sitting on and that panel has just been repainted.
///
/// `ThemeChanged` is emitted for the *apps* theme; the taskbar value is
/// re-read at that moment rather than watched on its own. The two change
/// together under Windows' plain Light/Dark modes, so only a "Custom"
/// split changed on its own waits for the next apps-theme change.
///
/// macOS needs none of this: its template image is recoloured by the system,
/// so the glyph it was given at build time stays correct.
#[cfg(not(target_os = "macos"))]
pub fn apply_system_theme(app: &AppHandle) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_icon(Some(glyph_for_theme(&panel_theme(app))));
    }
}

#[cfg(all(test, not(target_os = "macos")))]
mod tests {
    use super::theme_for_light_flag;

    #[test]
    fn a_dark_taskbar_flag_picks_the_dark_panel_glyph() {
        assert_eq!(theme_for_light_flag(0), "dark");
    }

    #[test]
    fn any_light_taskbar_flag_picks_the_light_panel_glyph() {
        assert_eq!(theme_for_light_flag(1), "light");
        assert_eq!(theme_for_light_flag(2), "light");
    }
}

#[cfg(target_os = "macos")]
pub fn apply_system_theme(_app: &AppHandle) {}
