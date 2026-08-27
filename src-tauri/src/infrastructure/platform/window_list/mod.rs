//! Cross-platform "list/activate/close open windows" backend, dispatched by
//! target OS. Each backend is best-effort: `available()` reports whether
//! this session can support the feature at all (e.g. false on Wayland),
//! and every other call degrades to empty/no-op on failure rather than
//! erroring — matching `linux_focus`'s philosophy for anything touching
//! window-manager state we don't own.

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeWindow {
    /// Opaque, backend-specific (an X11 window id, an HWND, a macOS
    /// `pid:index`) — round-tripped back into `activate`/`close` verbatim.
    pub id: String,
    pub title: String,
    pub app_name: String,
    /// Lowercased identity hint (WM_CLASS, exe stem, bundle id) used to
    /// match this window against an installed app for its icon; the
    /// backend doesn't resolve icons itself, `application::navigation`
    /// does via the existing `AppScanner`.
    pub app_match_hint: String,
    /// Present only when the backend can extract a window-specific icon
    /// itself (e.g. `_NET_WM_ICON`), as a `data:image/png;base64,...` URI.
    /// The app-icon match above is tried first; this is the fallback.
    pub icon: Option<String>,
}

/// Whether this session can list/activate/close windows at all.
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

/// Open windows, roughly most-recently-used first. Empty when unavailable
/// or the query fails.
pub fn list() -> Vec<NativeWindow> {
    #[cfg(target_os = "linux")]
    {
        linux::list()
    }
    #[cfg(target_os = "macos")]
    {
        macos::list()
    }
    #[cfg(target_os = "windows")]
    {
        windows::list()
    }
}

/// Brings `id` to the foreground. Best-effort: returns whether the attempt
/// was even dispatched, not whether the window manager honored it.
pub fn activate(id: &str) -> bool {
    #[cfg(target_os = "linux")]
    {
        linux::activate(id)
    }
    #[cfg(target_os = "macos")]
    {
        macos::activate(id)
    }
    #[cfg(target_os = "windows")]
    {
        windows::activate(id)
    }
}

/// Asks `id`'s owner to close it (a graceful close request, not a kill).
pub fn close(id: &str) -> bool {
    #[cfg(target_os = "linux")]
    {
        linux::close(id)
    }
    #[cfg(target_os = "macos")]
    {
        macos::close(id)
    }
    #[cfg(target_os = "windows")]
    {
        windows::close(id)
    }
}
