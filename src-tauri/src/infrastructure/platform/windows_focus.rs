//! Windows' foreground-lock heuristic can silently ignore
//! `SetForegroundWindow` (what Tauri's `WebviewWindow::set_focus` calls
//! internally) unless the calling thread "owns" the current foreground
//! window's input state, or the last input event came from the process
//! asking. A global-hotkey-triggered show is usually fine; showing from the
//! tray icon or a single-instance re-launch often isn't. The standard,
//! well-documented workaround (used by most Win32 launcher-style apps) is
//! to temporarily attach this thread's input queue to the current
//! foreground window's thread before calling `SetForegroundWindow`, then
//! detach it again immediately after.

use std::sync::Mutex;

use tauri::WebviewWindow;
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId, SetForegroundWindow};

/// The window that had foreground status when the palette was last shown —
/// Navigation's menu-bar search target, the Windows analogue of
/// `linux_focus::PREVIOUS_FOCUS`. Stored as the raw pointer value (`HWND`
/// isn't `Send`/`Sync`); reconstructed at each use site.
static PREVIOUS_FOREGROUND: Mutex<Option<isize>> = Mutex::new(None);

/// Records the current foreground window. Call immediately *before*
/// showing the palette, mirroring `linux_focus::remember_focused_window`.
pub fn remember_foreground() {
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.0.is_null() {
        return;
    }
    *PREVIOUS_FOREGROUND.lock().unwrap() = Some(hwnd.0 as isize);
}

/// Reads the window captured by `remember_foreground` without consuming
/// it — used by Navigation's menu-bar reader.
pub fn previously_foreground_hwnd() -> Option<isize> {
    *PREVIOUS_FOREGROUND.lock().unwrap()
}

/// Best-effort — every Win32 call here can fail for reasons outside our
/// control (no foreground window, permission quirks under RDP/other
/// sessions), and the caller's own `window.set_focus()` right after this is
/// still the actual mechanism that shows/focuses the window; this only
/// raises the odds that call succeeds.
pub fn force_foreground(window: &WebviewWindow) {
    let Ok(tauri_hwnd) = window.hwnd() else { return };
    // Tauri's `windows` crate version and ours differ (see Cargo.lock), so
    // `HWND` is technically two distinct Rust types despite identical
    // layout (`HWND(pub *mut c_void)` in both) — round-trip through the
    // raw pointer rather than fighting the version mismatch.
    force_foreground_hwnd(HWND(tauri_hwnd.0));
}

/// The `force_foreground` mechanism, generalized to any window — Switch
/// Windows uses this directly to bring an arbitrary target forward, the
/// same way `force_foreground` already brings the palette forward.
pub fn force_foreground_hwnd(hwnd: HWND) {
    unsafe {
        let foreground = GetForegroundWindow();
        let foreground_thread = GetWindowThreadProcessId(foreground, None);
        let current_thread = GetCurrentThreadId();

        let attached = foreground_thread != 0
            && foreground_thread != current_thread
            && AttachThreadInput(current_thread, foreground_thread, true).as_bool();

        let _ = SetForegroundWindow(hwnd);

        if attached {
            let _ = AttachThreadInput(current_thread, foreground_thread, false);
        }
    }
}
