//! Accessibility-API window-geometry backend.
//!
//! Unverified on real hardware — this dev machine is Linux — see the
//! plan's Constraints. Written directly against the documented, stable
//! `objc2-app-kit`/`AXUIElement` APIs, following the exact conventions
//! `window_list`/`menu_bar`'s `macos.rs` already established (frontmost
//! app via `NSWorkspace`, AX element access via `macos_accessibility`).
//!
//! **Coordinate systems**: AX (and CoreGraphics generally, and this
//! module's own `Rect`) uses a single global space with top-left origin,
//! Y increasing downward. AppKit's `NSScreen` uses bottom-left origin, Y
//! increasing upward, with (0,0) anchored to the bottom-left of the
//! *primary* screen — the one `NSScreen.screens().first()` reports, which
//! owns the menu bar. Converting an NSScreen rect to AX/`Rect` coordinates
//! (see `ns_rect_to_ax`): x is unchanged; y flips via
//! `primary_screen_height - (y + height)`.

use objc2::MainThreadMarker;
use objc2_app_kit::{NSScreen, NSWorkspace};
use tauri::AppHandle;

use super::Rect;
use crate::infrastructure::platform::macos_accessibility::{self, AXElement};
use crate::infrastructure::platform::macos_panel;

pub fn available() -> bool {
    macos_accessibility::is_trusted()
}

/// The frontmost app's pid, as a string. Every other call re-resolves
/// `AXFocusedWindow` fresh from this pid rather than caching a window
/// handle — macOS has no stable "window index" the way `window_list`'s
/// `pid:index` scheme does, and re-querying "whichever window is focused
/// right now" is actually the *correct* semantics here, not a staleness
/// risk. No own-process guard is needed (unlike Linux/Windows): the
/// palette is a non-activating `NSPanel` (see `macos_panel.rs`), so it
/// never becomes the frontmost app and the frontmost app is always a real
/// target.
pub fn target() -> Option<String> {
    if !macos_accessibility::ensure_trusted_with_prompt() {
        return None;
    }
    let pid = NSWorkspace::sharedWorkspace().frontmostApplication()?.processIdentifier();
    Some(pid.to_string())
}

fn focused_window(id: &str) -> Option<AXElement> {
    let pid: i32 = id.parse().ok()?;
    let app = AXElement::for_application(pid)?;
    app.attribute_element("AXFocusedWindow")
}

pub fn frame(id: &str) -> Option<Rect> {
    let window = focused_window(id)?;
    let (x, y) = window.attribute_point("AXPosition")?;
    let (w, h) = window.attribute_size("AXSize")?;
    Some(Rect { x, y, w, h })
}

pub fn set_frame(id: &str, rect: Rect) -> bool {
    let Some(window) = focused_window(id) else { return false };
    // The documented AX dance for a move that crosses displays: writing
    // position before size (or size before position, just once) can clamp
    // against the *original* display's bounds rather than the target one.
    // Writing size, then position, then size again reliably lands both —
    // the same workaround other AX-based window managers use.
    window.set_size(rect.w, rect.h);
    let moved = window.set_position(rect.x, rect.y);
    let resized = window.set_size(rect.w, rect.h);
    moved && resized
}

/// `NSScreen` — unlike everything else in this file, which goes through
/// `ApplicationServices`/AX C calls documented as callable from any thread
/// (see `AXElement`'s doc comment) — is AppKit, and AppKit is main-thread
/// -only. Found live: every call here returned `None` (`MainThreadMarker::
/// new()` correctly refusing to hand out a marker, not a crash to notice
/// by) because `host.window.getWorkArea`/`listDisplays` run on whatever
/// tokio task is handling the extension bridge request, never the main
/// thread — so every Window Management preset silently no-opped on
/// `applyFrame`'s "Couldn't determine the screen area" branch before ever
/// reaching `setFrame`. Same class of bug `macos_panel.rs`'s `on_main_thread`
/// already exists to fix for NSPanel calls; reused here rather than a
/// second copy of the same main-thread dispatch.
pub fn work_area(app: &AppHandle, id: &str) -> Option<Rect> {
    let window = focused_window(id)?;
    let (x, y) = window.attribute_point("AXPosition")?;
    let (w, h) = window.attribute_size("AXSize")?;
    let center_x = x + w / 2.0;
    let center_y = y + h / 2.0;

    macos_panel::on_main_thread(app, move || {
        let mtm = MainThreadMarker::new()?;
        let screens = NSScreen::screens(mtm).to_vec();
        let primary_height = screens.first()?.frame().size.height;

        let target_screen = screens
            .iter()
            .find(|screen| {
                let f = screen.frame();
                let r = ns_rect_to_ax(f.origin.x, f.origin.y, f.size.width, f.size.height, primary_height);
                center_x >= r.x && center_x < r.x + r.w && center_y >= r.y && center_y < r.y + r.h
            })
            .or_else(|| screens.first())?;

        let vf = target_screen.visibleFrame();
        Some(ns_rect_to_ax(vf.origin.x, vf.origin.y, vf.size.width, vf.size.height, primary_height))
    })
}

/// See `work_area`'s doc comment — same main-thread requirement, same fix.
pub fn displays(app: &AppHandle) -> Vec<Rect> {
    macos_panel::on_main_thread(app, || {
        let Some(mtm) = MainThreadMarker::new() else { return Vec::new() };
        let screens = NSScreen::screens(mtm).to_vec();
        let Some(primary_height) = screens.first().map(|s| s.frame().size.height) else { return Vec::new() };
        screens
            .iter()
            .map(|screen| {
                let f = screen.frame();
                ns_rect_to_ax(f.origin.x, f.origin.y, f.size.width, f.size.height, primary_height)
            })
            .collect()
    })
}

pub fn set_fullscreen(id: &str, fullscreen: bool) -> bool {
    let Some(window) = focused_window(id) else { return false };
    window.set_attribute_bool("AXFullScreen", fullscreen)
}

/// Converts an NSScreen-space rect (bottom-left origin, Y-up) to AX/`Rect`
/// space (top-left origin, Y-down) — see the module doc for the formula's
/// derivation. Pure so it's the one piece of this file's logic that could
/// be unit-tested on any platform in principle; kept un-tested here
/// because the whole file is `#[cfg(target_os = "macos")]`-gated at the
/// `mod` declaration in `window_manage/mod.rs` (matching `window_list`/
/// `menu_bar`'s `macos.rs`, neither of which has Linux-runnable tests
/// either) — this doc comment is the review aid in its place.
fn ns_rect_to_ax(x: f64, y: f64, width: f64, height: f64, primary_screen_height: f64) -> Rect {
    Rect { x, y: primary_screen_height - (y + height), w: width, h: height }
}
