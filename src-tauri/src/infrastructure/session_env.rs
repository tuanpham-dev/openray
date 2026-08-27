/// Whether we're running under a Wayland session. Shared by the paste
/// injector (which can't synthesize keystrokes on Wayland, only copy to the
/// clipboard) and the hotkey registrar (which needs the XDG portal instead
/// of `tauri-plugin-global-shortcut`'s X11-only key-grab approach there).
pub fn is_wayland() -> bool {
    cfg!(target_os = "linux")
        && (std::env::var("WAYLAND_DISPLAY").is_ok()
            || std::env::var("XDG_SESSION_TYPE").map(|v| v == "wayland").unwrap_or(false))
}
