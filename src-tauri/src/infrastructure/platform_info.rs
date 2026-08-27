use serde::Serialize;

use crate::infrastructure::platform::{drop_at_cursor, menu_bar, window_manage};
use crate::infrastructure::session_env::is_wayland;

/// Resolved once per command launch (see `extension_commands::launch`) and
/// handed to the extension host as part of `environment` — not a live
/// bridge call, since none of these facts change during a command's
/// lifetime. `@openray/extras`'s `platform`/`capabilities` exports read the
/// values this produces straight out of `CommandContext`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformInfo {
    pub os: &'static str,
    pub display_server: Option<&'static str>,
    pub capabilities: Capabilities,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub selection_read: bool,
    pub drop_at_cursor: bool,
    pub multi_format_clipboard: bool,
    pub menu_bar_introspection: bool,
    pub window_control: bool,
}

/// Used only if the startup `std::thread::spawn(snapshot).join()` call
/// itself panics — every capability conservatively `false` rather than
/// guessing, matching `command-context.ts`'s fallback `CommandContext`.
pub fn snapshot_conservative() -> PlatformInfo {
    let os = if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    };
    PlatformInfo {
        os,
        display_server: None,
        capabilities: Capabilities {
            selection_read: false,
            drop_at_cursor: false,
            multi_format_clipboard: false,
            menu_bar_introspection: false,
            window_control: false,
        },
    }
}

pub fn snapshot() -> PlatformInfo {
    let os = if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    };

    let display_server = cfg!(target_os = "linux").then(|| if is_wayland() { "wayland" } else { "x11" });

    // `SelectionReader` (T11): the X11 backend reads the PRIMARY selection
    // directly and has no Wayland equivalent at all (`None`, not a
    // degraded result); macOS/Windows always attempt the synthesized-copy
    // fallback, so they're capability-true even though any single call can
    // still fail for reasons outside this app's control — matching how
    // `menu_bar`/`window_manage`'s own `available()` treats "capable in
    // principle" separately from "this particular call succeeded".
    let selection_read = if cfg!(target_os = "linux") { !is_wayland() } else { true };

    PlatformInfo {
        os,
        display_server,
        capabilities: Capabilities {
            selection_read,
            drop_at_cursor: drop_at_cursor::supported(),
            // Real backends exist for x11/wayland/macos/windows alike (see
            // clipboard_multi's own module doc comment: "every backend is
            // best-effort" — there's no platform where it's fundamentally
            // impossible, only varying quality).
            multi_format_clipboard: true,
            menu_bar_introspection: menu_bar::available(),
            window_control: window_manage::available(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_reports_this_build_targets_platform() {
        let info = snapshot();
        assert_eq!(info.os, if cfg!(target_os = "macos") { "macos" } else if cfg!(target_os = "windows") { "windows" } else { "linux" });
        assert_eq!(info.display_server.is_some(), cfg!(target_os = "linux"));
    }
}
