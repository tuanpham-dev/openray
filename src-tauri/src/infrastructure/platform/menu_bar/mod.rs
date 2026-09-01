//! Cross-platform "read/activate the previously-focused app's menu bar"
//! backend, dispatched by target OS. Best-effort like `window_list`: a
//! window/app that exports nothing yields an empty node list, never an
//! error — `application::navigation` turns that into an explicit "no menu
//! bar items found" state rather than surfacing a failure.
//!
//! Each backend resolves its own notion of "the target app" internally
//! (Linux/Windows peek the remembered previously-focused window; macOS has
//! no need to track one since the palette never steals activation, so the
//! target is simply the frontmost app), so `read`/`activate` take no
//! target parameter.

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

#[derive(Debug, Clone, PartialEq)]
pub enum RawMenuNode {
    Item { title: String, enabled: bool, shortcut: Option<String>, token: String },
    Submenu { title: String, enabled: bool, children: Vec<RawMenuNode> },
    /// Constructed by `linux.rs`/`windows.rs`; `macos.rs`'s AX-based reader
    /// doesn't currently distinguish a separator from an absent item, so
    /// this platform's backend never builds one. Genuinely unused there,
    /// not dead across the type as a whole.
    #[allow(dead_code)]
    Separator,
}

#[derive(Debug, Clone, Default)]
pub struct MenuBarRead {
    /// Name of the app the menu was read from, when a target could be
    /// resolved at all — used to phrase the empty state ("No menu bar
    /// items found for Firefox") even when `nodes` ends up empty.
    pub app_name: Option<String>,
    pub nodes: Vec<RawMenuNode>,
}

/// Whether this session can read app menu bars at all.
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

pub fn read() -> MenuBarRead {
    #[cfg(target_os = "linux")]
    {
        linux::read()
    }
    #[cfg(target_os = "macos")]
    {
        macos::read()
    }
    #[cfg(target_os = "windows")]
    {
        windows::read()
    }
}

/// Triggers the menu item identified by `token` (as produced in a node
/// this same backend returned from `read`).
pub fn activate(token: &str) -> bool {
    #[cfg(target_os = "linux")]
    {
        linux::activate(token)
    }
    #[cfg(target_os = "macos")]
    {
        macos::activate(token)
    }
    #[cfg(target_os = "windows")]
    {
        windows::activate(token)
    }
}
