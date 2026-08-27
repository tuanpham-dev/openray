//! Converts the palette's `WebviewWindow` into a non-activating `NSPanel`
//! on first setup, so showing OpenRay never makes it the frontmost/active
//! application — the previously-focused app keeps its activation state,
//! which is what real Raycast/Spotlight-style launchers do and what
//! paste-injection (T21+) depends on: `SystemPasteInjector::paste`
//! simulates Cmd+V into "whatever app is now focused" after the palette
//! hides, which only stays correct if the palette never stole that focus
//! in the first place.
//!
//! `can_become_key_window: true` lets the search field still receive
//! keystrokes while the panel is showing (a panel that could never become
//! key couldn't be typed into); `can_become_main_window: false` plus the
//! floating-panel style is what keeps the OS from treating OpenRay as the
//! active application. These are two independent AppKit mechanisms — key
//! window vs. active app — and Spotlight-style panels rely on exactly this
//! split.

use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_nspanel::{tauri_panel, CollectionBehavior, ManagerExt, WebviewWindowExt};

use crate::error::Error;

tauri_panel! {
    panel!(PalettePanel {
        config: {
            can_become_key_window: true,
            can_become_main_window: false,
            is_floating_panel: true,
            becomes_key_only_if_needed: false,
            hides_on_deactivate: false
        }
    })
}

/// Converts an already-built palette window into a `PalettePanel`. Must run
/// once during setup, after the window is created but before it's first
/// shown — `to_panel` swaps the underlying NSWindow's class, and doing that
/// while visible would be observable (a flicker) rather than merely
/// pointless.
pub fn install(window: &WebviewWindow) -> tauri::Result<()> {
    let panel = window.to_panel::<PalettePanel>()?;
    // Visible above the currently active fullscreen space too — a global
    // launcher that only worked on whichever space happened to be active
    // when it was last hidden would be a constant surprise.
    panel.set_collection_behavior(CollectionBehavior::new().can_join_all_spaces().into());
    Ok(())
}

pub fn show(app: &AppHandle, label: &str) -> Result<(), Error> {
    app.get_webview_panel(label).map_err(|e| Error::msg(format!("{e:?}")))?.show_and_make_key();
    Ok(())
}

pub fn hide(app: &AppHandle, label: &str) -> Result<(), Error> {
    app.get_webview_panel(label).map_err(|e| Error::msg(format!("{e:?}")))?.hide();
    Ok(())
}

pub fn is_visible(app: &AppHandle, label: &str) -> Result<bool, Error> {
    Ok(app.get_webview_panel(label).map_err(|e| Error::msg(format!("{e:?}")))?.is_visible())
}
