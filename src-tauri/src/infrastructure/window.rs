use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

use crate::error::Error;
#[cfg(target_os = "macos")]
use crate::infrastructure::platform::macos_panel;
use crate::infrastructure::settings::SettingsStore;

pub const PALETTE_WINDOW_LABEL: &str = "main";
pub const SETTINGS_WINDOW_LABEL: &str = "settings";

/// Transparent margin kept around the palette on every side. The window
/// itself is a plain rectangle, so a rounded palette needs its drop shadow
/// drawn in CSS (the compositor's own `shadow` option traces the
/// rectangular window frame, not the rounded content — that's why it's
/// disabled in tauri.conf.json). A CSS `box-shadow` renders *outside* the
/// element's border box, so without this margin it would be clipped at the
/// window edge and the palette would look like a hard-edged rectangle.
const PALETTE_SHADOW_MARGIN: f64 = 14.0;

/// The palette's own visible size, excluding `PALETTE_SHADOW_MARGIN`.
fn palette_dimensions(size: &str) -> (f64, f64) {
    match size {
        "small" => (600.0, 400.0),
        "large" => (900.0, 600.0),
        _ => (750.0, 475.0),
    }
}

/// The window size needed to show a palette of `size` plus its shadow
/// margin. Kept separate from `palette_dimensions` so the user-facing
/// "window size" setting keeps meaning the palette's size.
fn palette_window_dimensions(size: &str) -> (f64, f64) {
    let (width, height) = palette_dimensions(size);
    (width + PALETTE_SHADOW_MARGIN * 2.0, height + PALETTE_SHADOW_MARGIN * 2.0)
}

fn palette_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    app.get_webview_window(PALETTE_WINDOW_LABEL)
        .ok_or_else(|| tauri::Error::WindowNotFound)
}

/// Whether the physical point (`x`, `y`) falls inside a monitor whose
/// physical rect starts at (`mx`, `my`) and is `mw` x `mh`.
fn monitor_contains(mx: i32, my: i32, mw: u32, mh: u32, x: i32, y: i32) -> bool {
    x >= mx && x < mx + mw as i32 && y >= my && y < my + mh as i32
}

/// The monitor the pointer is currently on.
///
/// Deliberately does the hit test against `available_monitors()` instead of
/// calling `monitor_from_point`. `cursor_position()` reports *physical*
/// pixels while `monitor_from_point` treats its arguments as *logical* —
/// identical only at scale 1.0. On a fractionally-scaled display (e.g.
/// Xft.dpi 155 → ~1.61) the point gets scaled up before the lookup, so a
/// cursor in the lower half of one screen resolves to the monitor below
/// it. `monitor.position()`/`size()` are physical, matching the cursor, so
/// comparing them directly has no coordinate-space ambiguity.
fn monitor_under_cursor(window: &WebviewWindow) -> tauri::Result<Option<tauri::Monitor>> {
    let cursor = window.cursor_position()?;
    let (x, y) = (cursor.x as i32, cursor.y as i32);

    for monitor in window.available_monitors()? {
        let pos = monitor.position();
        let size = monitor.size();
        if monitor_contains(pos.x, pos.y, size.width, size.height, x, y) {
            return Ok(Some(monitor));
        }
    }

    Ok(None)
}

/// Centres `window` on `monitor` (or, absent one, falls back to the
/// toolkit's own `center()`).
///
/// Uses the window's real `outer_size` rather than `logical size × scale`:
/// the target monitor's scale factor isn't necessarily the one the window
/// was sized against, so on a mixed-DPI setup that product is the wrong
/// number and the window lands off-centre (or on the neighbouring screen).
fn center_on_monitor(window: &WebviewWindow, monitor: Option<tauri::Monitor>) -> tauri::Result<()> {
    let Some(monitor) = monitor else {
        return window.center();
    };

    let size = window.outer_size()?;
    let monitor_pos = monitor.position();
    let monitor_size = monitor.size();

    let x = monitor_pos.x + (monitor_size.width as i32 - size.width as i32) / 2;
    let y = monitor_pos.y + (monitor_size.height as i32 - size.height as i32) / 2;

    window.set_position(PhysicalPosition::new(x, y))
}

/// Centres the palette on whichever screen `show_on_screen` (`"cursor"` or
/// `"primary"`) selects — `"cursor"` is the pre-existing default: the
/// monitor the pointer is on, falling back to the window's current monitor
/// and then the primary one.
fn center_on_configured_screen(window: &WebviewWindow, show_on_screen: &str) -> tauri::Result<()> {
    let monitor = if show_on_screen == "primary" {
        window.primary_monitor()?
    } else {
        monitor_under_cursor(window)?.or(window.current_monitor()?).or(window.primary_monitor()?)
    };
    center_on_monitor(window, monitor)
}

/// Wakes the GTK main loop.
///
/// Window operations invoked off the main thread (a global-hotkey
/// callback, a tauri command worker) are marshalled to the main loop —
/// but the loop can already be parked in `poll` with the wakeup missed,
/// leaving the queued map/unmap unflushed until the *next* X event
/// arrives. That was directly observable: `hide()` returns Ok, GTK
/// reports the window invisible, and X keeps it on screen for seconds
/// until a keypress wakes the loop — which is exactly why the palette
/// needed a second Escape (and why the first keystroke after a hotkey
/// show sometimes vanished: it was spent waking the loop). GLib documents
/// `MainContext::wakeup` as thread-safe.
#[cfg(target_os = "linux")]
fn wake_main_loop() {
    glib::MainContext::default().wakeup();
}

#[cfg(not(target_os = "linux"))]
fn wake_main_loop() {}

pub fn show_palette(app: &AppHandle) -> Result<(), Error> {
    // Perf-baseline instrumentation (plans/refactor-extension-platform.md,
    // T33/T34) — `info`, not `debug`: see `api::search::search`'s comment
    // on why (tauri_plugin_log's level filter is hardcoded to Info).
    let started_at = std::time::Instant::now();
    let window = palette_window(app)?;

    // Before the palette takes focus, note who had it: hiding won't give
    // it back on its own, and paste injection needs the user's own window
    // focused to receive the keystroke.
    #[cfg(target_os = "linux")]
    crate::infrastructure::platform::linux_focus::remember_focused_window();

    // Navigation's menu-bar search target on Windows — the analogue of
    // the Linux call above (Windows has no equivalent restore-focus need,
    // since `set_focus()` below is the one mechanism, but Search Menu Bar
    // Items still needs to know which app was frontmost).
    #[cfg(target_os = "windows")]
    crate::infrastructure::platform::windows_focus::remember_foreground();

    let stored_settings = app.try_state::<Arc<SettingsStore>>().map(|settings| settings.get());
    let window_size_setting = stored_settings.as_ref().map(|s| s.window_size.clone()).unwrap_or_else(|| "medium".to_string());
    let show_on_screen = stored_settings.as_ref().map(|s| s.show_on_screen.clone()).unwrap_or_else(|| "cursor".to_string());
    let (width, height) = palette_window_dimensions(&window_size_setting);
    window.set_size(LogicalSize::new(width, height))?;

    // Positioned before showing so it appears in the right place rather
    // than jumping there.
    let _ = center_on_configured_screen(&window, &show_on_screen);

    #[cfg(target_os = "macos")]
    {
        // A plain window.show()+set_focus() would make OpenRay the active
        // application, stealing focus from whatever the user was in —
        // see macos_panel's doc comment for why that breaks paste
        // injection. The panel conversion happens once in lib.rs's setup;
        // by the time this runs, showing must go through the panel.
        macos_panel::show(app, PALETTE_WINDOW_LABEL)?;
    }

    #[cfg(target_os = "windows")]
    {
        window.show()?;
        // Must run before set_focus(): Windows can silently ignore
        // SetForegroundWindow (what set_focus calls) unless this process
        // currently "owns" input focus in the OS's eyes — see
        // windows_focus's doc comment. Showing via the tray icon or a
        // single-instance re-launch are exactly the cases this matters for;
        // a hotkey-triggered show usually would have worked regardless.
        crate::infrastructure::platform::windows_focus::force_foreground(&window);
        window.set_focus()?;
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        window.show()?;
        window.set_focus()?;
    }

    // Again after showing: X11 window managers apply their own placement
    // policy when a window is mapped, discarding a position set while it
    // was hidden — which is how the palette ends up on the wrong monitor.
    // This is also the first point `outer_size` reflects the size set
    // above, so it's the authoritative placement.
    center_on_configured_screen(&window, &show_on_screen)?;

    // The webview survives hide/show, so the previous query is still in
    // the search field. Announce the show so the field can select its
    // text — typing replaces the old query, Enter reuses it (Raycast's
    // reopen behaviour).
    let _ = app.emit("palette-shown", ());

    wake_main_loop();

    // The marshalled set_focus above can stall in the event loop, and the
    // WM won't focus a re-mapped window by itself (focus-stealing
    // prevention) — claim focus directly so the first keystroke lands
    // here.
    #[cfg(target_os = "linux")]
    crate::infrastructure::platform::linux_focus::focus_palette();

    log::info!("show_palette: {}us", started_at.elapsed().as_micros());
    Ok(())
}

/// Every hide path the frontend itself triggers (Escape, blur, running a
/// command) goes through this function — a single point to announce that
/// the palette went away, so `App.tsx` can time a "reset to root" against
/// `popToRootDelay` on the next `palette-shown`. Extension-triggered hides
/// go through `hide_palette_any` instead (they already run their own
/// pop-to-root logic via `extension-pop-to-root`), so this event doesn't
/// fire there.
pub fn hide_palette(app: &AppHandle) -> Result<(), Error> {
    #[cfg(target_os = "macos")]
    let result = macos_panel::hide(app, PALETTE_WINDOW_LABEL);

    #[cfg(not(target_os = "macos"))]
    let result: Result<(), Error> = (|| {
        palette_window(app)?.hide()?;
        wake_main_loop();

        // Belt and braces: the marshalled hide can stall in the event loop
        // (see force_unmap_palette); unmap at the server directly so the
        // window leaves the screen now.
        #[cfg(target_os = "linux")]
        crate::infrastructure::platform::linux_focus::force_unmap_palette();

        // Hand focus back to whatever the user was in. Without this the
        // hidden palette keeps input focus, and the paste keystroke that
        // follows a snippet or clipboard entry lands nowhere.
        #[cfg(target_os = "linux")]
        crate::infrastructure::platform::linux_focus::restore_focus();

        Ok(())
    })();

    if result.is_ok() {
        let _ = app.emit("palette-hidden", ());
    }
    result
}

/// Hides the palette from a caller that is generic over the Tauri runtime
/// (the extension bridge), sharing the focus hand-back with the normal
/// path.
///
/// macOS's panel-based hide needs the concrete runtime, so this performs a
/// plain `hide()` there rather than going through `macos_panel`; the
/// window is still the panel installed at startup.
pub fn hide_palette_any<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<(), Error> {
    if let Some(window) = app.get_webview_window(PALETTE_WINDOW_LABEL) {
        window.hide()?;
        wake_main_loop();
        #[cfg(target_os = "linux")]
        crate::infrastructure::platform::linux_focus::force_unmap_palette();
    }

    #[cfg(target_os = "linux")]
    crate::infrastructure::platform::linux_focus::restore_focus();

    Ok(())
}

pub fn toggle_palette(app: &AppHandle) -> Result<(), Error> {
    #[cfg(target_os = "macos")]
    let currently_visible = macos_panel::is_visible(app, PALETTE_WINDOW_LABEL)?;
    #[cfg(not(target_os = "macos"))]
    let currently_visible = palette_window(app)?.is_visible()?;

    if currently_visible {
        hide_palette(app)
    } else {
        show_palette(app)
    }
}

/// The OS-resolved light/dark scheme, as `"light"` or `"dark"`. Used for
/// `settings.theme == "system"` instead of relying on the webview's own
/// `prefers-color-scheme` CSS media query, which WebKitGTK on Linux doesn't
/// reliably keep in sync with the desktop's actual dark-mode setting —
/// Tauri's own theme detection (backed by the OS/GTK APIs directly) is the
/// trustworthy source here, forwarded to the frontend as an explicit
/// `data-theme` value rather than a CSS-level guess.
///
/// On Linux, Tauri's own detection goes through the XDG desktop portal
/// (`org.freedesktop.portal.Settings`), which silently falls back to
/// `"light"` whenever the portal fails to activate — no portal-frontend
/// implementation is registered on many non-GNOME sessions (XFCE, etc.),
/// so this is common, not an edge case. `gsettings` reads the same
/// `org.gnome.desktop.interface color-scheme` key directly without going
/// through the portal and works on any GTK-based desktop (XFCE bridges it
/// via xsettings), so it's tried first; Tauri's own result is the fallback
/// for desktops where `gsettings` itself isn't available (e.g. non-GTK).
pub fn system_theme(app: &AppHandle) -> String {
    #[cfg(target_os = "linux")]
    if let Some(theme) = crate::infrastructure::platform::linux::gsettings_color_scheme() {
        return theme;
    }

    palette_window(app).and_then(|w| w.theme()).map(|t| t.to_string()).unwrap_or_else(|_| "light".to_string())
}

/// Which pane Settings should open on.
///
/// `openExtensionPreferences()` / `openCommandPreferences()` name a target
/// rather than dumping the user on General and letting them hunt — see
/// `api::extensions`' bridge handlers.
#[derive(Debug, Clone, Copy, Default)]
pub enum SettingsTarget<'a> {
    #[default]
    General,
    Extension(&'a str),
    Command {
        extension_id: &'a str,
        command_name: &'a str,
    },
}

impl SettingsTarget<'_> {
    /// The frontend reads these off the hash — see `SettingsWindow.tsx`.
    fn to_url(self) -> String {
        match self {
            SettingsTarget::General => "index.html#/settings".to_string(),
            SettingsTarget::Extension(id) => {
                format!("index.html#/settings?extension={}", urlencoding::encode(id))
            }
            SettingsTarget::Command { extension_id, command_name } => format!(
                "index.html#/settings?extension={}&command={}",
                urlencoding::encode(extension_id),
                urlencoding::encode(command_name)
            ),
        }
    }
}

pub fn open_settings_window(app: &AppHandle, target: SettingsTarget<'_>) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(SETTINGS_WINDOW_LABEL) {
        window.show()?;
        window.set_focus()?;
        // An already-open window is re-pointed rather than left where it
        // was: an extension asking for its own preferences while Settings
        // happens to be open on another pane would otherwise look like the
        // call did nothing.
        if !matches!(target, SettingsTarget::General) {
            let _ = window.eval(format!("window.location.hash = {}", serde_json::json!(
                target.to_url().trim_start_matches("index.html#")
            )));
        }
        return Ok(());
    }

    WebviewWindowBuilder::new(app, SETTINGS_WINDOW_LABEL, WebviewUrl::App(target.to_url().into()))
        .title("OpenRay Settings")
        .inner_size(980.0, 620.0)
        .min_inner_size(800.0, 520.0)
        .resizable(true)
        .decorations(true)
        .build()?;

    Ok(())
}


/// T24: prefixes every extension-owned window's generated label, so
/// `dispatch_notification`'s `ui.commit` router and any future
/// "for every extension window" sweep can recognize one on sight without
/// consulting a separate registry.
const EXTENSION_WINDOW_LABEL_PREFIX: &str = "ext-window-";

static EXTENSION_WINDOW_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Size/decoration options the `Window` shim surface (T24) exposes —
/// mirrors `plans/refactor-extension-platform.md`'s T24 bullet ("open/
/// close/focus, size/decorations/always-on-top options") one for one.
pub struct ExtensionWindowOptions {
    pub title: String,
    pub width: f64,
    pub height: f64,
    pub decorations: bool,
    pub always_on_top: bool,
}

impl Default for ExtensionWindowOptions {
    fn default() -> Self {
        Self { title: "OpenRay".to_string(), width: 700.0, height: 500.0, decorations: true, always_on_top: false }
    }
}

/// Creates a new window hosting `TreeRenderer` bound to the command tree an
/// extension mounts into it (the `Window` shim's `openExtensionWindow`,
/// `packages/api-shim/src/api/extension-window.ts`) — the primitive T26's
/// Notes window is expected to move onto. A fresh label per call (unlike
/// `notes_window`'s single reused one): any number of extension windows can
/// be open concurrently, each with its own independently-mounted tree.
///
/// Uses the same plain-secondary-window class as `notes_window`/
/// `open_settings_window` — no `macos_panel`/`linux_focus` dance, since an
/// explicitly-opened extension window behaves like Notes/Settings (a
/// normal window the user can leave focused), not the palette's transient,
/// focus-stealing-averse overlay. Escape is handled locally by the
/// extension window's webview, so it never captures Escape from other apps.
///
/// The frontend loaded at `#/extension-window/{label}` doesn't yet have
/// anything to render at this point — the caller (Node's window mounter)
/// only starts streaming `ui.commit`s once the page itself confirms it's
/// listening (`notify_extension_window_ready`), so no commit can be lost
/// to a page that hasn't finished loading.
pub fn open_extension_window(app: &AppHandle, options: ExtensionWindowOptions) -> tauri::Result<String> {
    let id = EXTENSION_WINDOW_COUNTER.fetch_add(1, Ordering::SeqCst);
    let label = format!("{EXTENSION_WINDOW_LABEL_PREFIX}{id}");

    let url = format!("index.html#/extension-window/{label}");
    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url.into()))
        .title(options.title)
        .inner_size(options.width, options.height)
        .min_inner_size(320.0, 240.0)
        .resizable(true)
        .decorations(options.decorations)
        .always_on_top(options.always_on_top)
        .build()?;

    // A user closing the window via its native chrome must still tell Node
    // to tear the mount down. `Destroyed` (not `CloseRequested`, which is
    // preventable and fires before teardown) is the single, unconditional
    // signal every close path funnels through.
    let app_for_close = app.clone();
    let label_for_close = label.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            let app_for_notify = app_for_close.clone();
            let label_for_notify = label_for_close.clone();
            tauri::async_runtime::spawn(async move {
                if let Some(state) = app_for_notify.try_state::<crate::application::state::AppState>() {
                    let _ = state
                        .extension_host
                        .notify("extension.windowClosed", Some(serde_json::json!({ "windowLabel": label_for_notify })))
                        .await;
                }
            });
        }
    });

    Ok(label)
}

/// Closes an extension window the `Window` shim asked to be opened.
/// Notifying Node happens in `open_extension_window`'s `Destroyed` handler,
/// not here — `window.close()`
/// unconditionally raises that event, so routing cleanup through the one
/// handler avoids ever running it twice (once here, once from native
/// chrome) for the same close.
/// `window.close()` alone reproduces the exact hazard `show_palette`/
/// `toggle_notes_window`'s own doc comments describe: the GTK main loop can
/// already be parked in `poll` with the wakeup missed, leaving the queued
/// unmap/destroy unflushed until the next X event happens to arrive —
/// confirmed live (T26): Escape-closing a Notes window left it fully
/// visible and unresponsive to further `xdotool search`/mouse-move probes,
/// exactly the same symptom, until `wake_main_loop()` was added here.
/// `close_extension_window_command` (below) is what the frontend actually
/// calls on Escape specifically *because* Tauri's own built-in
/// `getCurrentWindow().close()` bypasses this fix entirely — routing
/// through a real Tauri command is what makes the wake-up happen at all.
pub fn close_extension_window(app: &AppHandle, label: &str) -> Result<(), Error> {
    if let Some(window) = app.get_webview_window(label) {
        window.close()?;
        wake_main_loop();
    }
    Ok(())
}

pub fn focus_extension_window(app: &AppHandle, label: &str) -> Result<(), Error> {
    if let Some(window) = app.get_webview_window(label) {
        window.show()?;
        window.set_focus()?;
        wake_main_loop();
    }
    Ok(())
}

/// Owns the one concrete `AppHandle` (`Wry`, the only real runtime this app
/// ever ships against) needed to create/close/focus extension-owned
/// windows — constructed once in `lib.rs::build_app_state` (a concrete-Wry
/// context: `tauri::App` is never generic) and stored on `AppState`.
///
/// `extension_bridge::dispatch_request` is deliberately generic over
/// `R: tauri::Runtime` so its request-validation paths can be exercised
/// with `tauri::test::MockRuntime` (see that module's tests) — but the
/// functions above genuinely need `WebviewWindowBuilder` and
/// `infrastructure::hotkey`'s Escape-grab machinery, both concrete-Wry only
/// (hotkey.rs stays non-generic everywhere else too, deliberately: it's
/// already the app's most deadlock-sensitive code, and threading a runtime
/// parameter through it for this one caller isn't worth the risk). Routing
/// through this struct — a plain value the generic dispatch code can call
/// methods on without itself needing to be concrete — sidesteps the
/// mismatch entirely, the same way `NotesProvider`/`ScreenshotsProvider`
/// already capture their own concrete `AppHandle` once at construction
/// instead of receiving a generic one per call.
#[derive(Clone)]
pub struct ExtensionWindows {
    app: AppHandle,
}

impl ExtensionWindows {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }

    pub fn open(&self, options: ExtensionWindowOptions) -> tauri::Result<String> {
        open_extension_window(&self.app, options)
    }

    pub fn close(&self, label: &str) -> Result<(), Error> {
        close_extension_window(&self.app, label)
    }

    pub fn focus(&self, label: &str) -> Result<(), Error> {
        focus_extension_window(&self.app, label)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A vertically-stacked layout: a 5120x2880 screen at the origin with a
    // 3491x1964 screen below and slightly inset, which is where the
    // physical/logical mix-up used to send the palette.
    const TOP: (i32, i32, u32, u32) = (0, 0, 5120, 2880);
    const BOTTOM: (i32, i32, u32, u32) = (692, 2880, 3491, 1964);

    fn contains(monitor: (i32, i32, u32, u32), x: i32, y: i32) -> bool {
        monitor_contains(monitor.0, monitor.1, monitor.2, monitor.3, x, y)
    }

    #[test]
    fn lower_half_of_the_top_screen_belongs_to_the_top_screen() {
        // The regression: at ~1.61 scale this point scaled to (4133, 3552),
        // which really is inside the bottom monitor.
        assert!(contains(TOP, 2560, 2200));
        assert!(!contains(BOTTOM, 2560, 2200));
    }

    #[test]
    fn points_on_the_bottom_screen_belong_to_it() {
        assert!(contains(BOTTOM, 2560, 3500));
        assert!(!contains(TOP, 2560, 3500));
    }

    #[test]
    fn monitor_edges_are_half_open() {
        // The shared boundary belongs to exactly one screen.
        assert!(contains(TOP, 0, 2879));
        assert!(!contains(TOP, 0, 2880));
        assert!(contains(BOTTOM, 692, 2880));
    }

    #[test]
    fn points_outside_every_monitor_match_none() {
        assert!(!contains(TOP, -1, 100));
        assert!(!contains(BOTTOM, 100, 3500));
    }
}
