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
//!
//! That split only actually works with one more piece `tauri_panel!`'s
//! `config:` block has no slot for: the `NSWindowStyleMaskNonactivatingPanel`
//! style-mask bit. Without it, `-makeKeyWindow` (what `show()` below calls)
//! does not hand real keyboard focus to a panel belonging to a background
//! (non-active) app — the panel orders to the front and *looks* focused,
//! but the OS keeps routing keystrokes to whatever app was actually active,
//! same as if nothing but `orderFrontRegardless` had been called. Found
//! live: `openray run` on a view-mode command showed the palette, but
//! typing landed in the terminal that ran the CLI command, not the search
//! field — `install` below now sets this bit explicitly right after
//! conversion, the one time it needs setting.

use std::sync::mpsc;

use objc2_app_kit::NSWindowStyleMask;
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
    // Read the style mask `to_panel` inherits from the plain WebviewWindow
    // (Tauri's own `decorations`/`resizable` config already shaped it) so
    // this only *adds* the non-activating bit rather than clobbering it.
    let ns_window = window.ns_window()?;
    let existing_mask = unsafe { (*ns_window.cast::<objc2_app_kit::NSWindow>()).styleMask() };

    let panel = window.to_panel::<PalettePanel>()?;
    panel.set_style_mask(existing_mask | NSWindowStyleMask::NonactivatingPanel);
    // Visible above the currently active fullscreen space too — a global
    // launcher that only worked on whichever space happened to be active
    // when it was last hidden would be a constant surprise.
    panel.set_collection_behavior(CollectionBehavior::new().can_join_all_spaces().into());
    Ok(())
}

/// AppKit calls are main-thread-only, and modern macOS hard-crashes (a
/// trap, not a catchable panic) rather than merely warning when that's
/// violated — or, for a class not covered by that trap (`NSScreen`, see
/// `window_manage/macos.rs`'s `work_area`/`displays`), just returns
/// nothing, no crash to even notice by. Two callers reach `show`/`hide`/
/// `is_visible` off the main thread: `hotkey.rs::dispatch` deliberately
/// runs on a spawned thread (see its doc comment on the X11 deadlock that
/// requires), and the single-instance relaunch callback (`lib.rs`) isn't
/// marshalled at all. Neither was ever exercised on real macOS before —
/// cross-compile checks can't catch a runtime threading violation — so
/// route through the main thread here, once, rather than requiring every
/// caller to remember to. `pub(crate)`: `window_manage/macos.rs` reuses
/// this exact helper rather than a second copy of the same dispatch.
pub(crate) fn on_main_thread<T: Send + 'static>(app: &AppHandle, f: impl FnOnce() -> T + Send + 'static) -> T {
    if objc2::MainThreadMarker::new().is_some() {
        return f();
    }
    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .expect("main event loop should still be running");
    rx.recv().expect("main thread dropped the result sender without running the task")
}

pub fn show(app: &AppHandle, label: &str) -> Result<(), Error> {
    let inner = app.clone();
    let label = label.to_string();
    on_main_thread(app, move || {
        inner.get_webview_panel(&label).map_err(|e| Error::msg(format!("{e:?}")))?.show_and_make_key();
        Ok(())
    })
}

pub fn hide(app: &AppHandle, label: &str) -> Result<(), Error> {
    let inner = app.clone();
    let label = label.to_string();
    on_main_thread(app, move || {
        inner.get_webview_panel(&label).map_err(|e| Error::msg(format!("{e:?}")))?.hide();
        Ok(())
    })
}

pub fn is_visible(app: &AppHandle, label: &str) -> Result<bool, Error> {
    let inner = app.clone();
    let label = label.to_string();
    on_main_thread(app, move || {
        Ok(inner.get_webview_panel(&label).map_err(|e| Error::msg(format!("{e:?}")))?.is_visible())
    })
}
