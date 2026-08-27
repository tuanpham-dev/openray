//! Cross-platform window-geometry I/O, dispatched by target OS — the
//! counterpart to `window_list` (enumerate/activate/close) for reading and
//! writing a single window's frame. Every rectangle preset's actual math
//! now lives in `extensions/window-management`'s TypeScript port
//! (`@openray/window-layout`, T18) — the Rust side that used to own it
//! (`application::window_management::layout`) was deleted that same
//! task; this module and its per-OS backends only resolve a target
//! window and get/set its geometry, reached via `host.window.*`
//! (`application::extension_bridge`). Best-effort throughout:
//! `available()` reports whether this session can support the feature at
//! all (e.g. false on Wayland), and every other call degrades to
//! `None`/`false`/empty on failure rather than erroring — matching
//! `window_list`'s philosophy.

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

/// A window frame in screen coordinates. Distinct from
/// `@openray/window-layout`'s own `Rect` — that's the pure-math type on
/// the TypeScript side; `extension_bridge.rs`'s `host.window.*` handlers
/// convert at the boundary, the same split `window_list::NativeWindow`
/// keeps from `domain::command::Command`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Whether this session can read/write window geometry at all.
pub fn available() -> bool {
    #[cfg(target_os = "linux")]
    {
        linux::available()
    }
    #[cfg(target_os = "macos")]
    {
        macos::available()
    }
    #[cfg(target_os = "windows")]
    {
        windows::available()
    }
}

/// The window a command should act on: the previously-focused/foreground
/// window if the palette (or another of our own windows) currently holds
/// focus, otherwise whatever's focused right now. Covers both the
/// palette-open (`run_command` hides first) and hotkey (palette never
/// shown) invocation paths uniformly. Opaque, backend-specific id (an X11
/// window id, an HWND, a macOS `pid:ax-index`).
pub fn target() -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        linux::target()
    }
    #[cfg(target_os = "macos")]
    {
        macos::target()
    }
    #[cfg(target_os = "windows")]
    {
        windows::target()
    }
}

/// The target's current frame, or `None` if it can't be read (window
/// closed since resolution, permission denied, …).
pub fn frame(id: &str) -> Option<Rect> {
    #[cfg(target_os = "linux")]
    {
        linux::frame(id)
    }
    #[cfg(target_os = "macos")]
    {
        macos::frame(id)
    }
    #[cfg(target_os = "windows")]
    {
        windows::frame(id)
    }
}

/// Applies `rect` to the target. Returns whether the write was even
/// dispatched, not whether the window manager honored it exactly.
pub fn set_frame(id: &str, rect: Rect) -> bool {
    #[cfg(target_os = "linux")]
    {
        linux::set_frame(id, rect)
    }
    #[cfg(target_os = "macos")]
    {
        macos::set_frame(id, rect)
    }
    #[cfg(target_os = "windows")]
    {
        windows::set_frame(id, rect)
    }
}

/// The usable area (screen minus taskbar/dock/menu bar) of the display
/// showing the target, or `None` if it can't be determined.
pub fn work_area(id: &str) -> Option<Rect> {
    #[cfg(target_os = "linux")]
    {
        linux::work_area(id)
    }
    #[cfg(target_os = "macos")]
    {
        macos::work_area(id)
    }
    #[cfg(target_os = "windows")]
    {
        windows::work_area(id)
    }
}

/// Raw monitor bounds (not work areas — no panel/dock/menu-bar inset) of
/// every connected display, in a stable order. Used for Next/Previous
/// Display remapping (deliberately edge-to-edge, not work-area-to-work-area
/// — `hop_display` just needs each display's own bounds to preserve
/// relative position) and to decide whether those two commands should even
/// be listed (hidden below two displays).
pub fn displays() -> Vec<Rect> {
    #[cfg(target_os = "linux")]
    {
        linux::displays()
    }
    #[cfg(target_os = "macos")]
    {
        macos::displays()
    }
    #[cfg(target_os = "windows")]
    {
        windows::displays()
    }
}

/// Enters/exits native OS fullscreen for the target. Returns whether the
/// request was dispatched.
pub fn set_fullscreen(id: &str, fullscreen: bool) -> bool {
    #[cfg(target_os = "linux")]
    {
        linux::set_fullscreen(id, fullscreen)
    }
    #[cfg(target_os = "macos")]
    {
        macos::set_fullscreen(id, fullscreen)
    }
    #[cfg(target_os = "windows")]
    {
        windows::set_fullscreen(id, fullscreen)
    }
}
