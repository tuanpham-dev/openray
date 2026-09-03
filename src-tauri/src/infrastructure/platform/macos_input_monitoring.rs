//! macOS Input-Monitoring permission for snippet auto-expansion's global
//! keystroke listener (`application::auto_expand`, the CGEventTap in `macos_keytap`).
//!
//! Observing keystrokes system-wide through a CGEventTap requires the
//! **Input Monitoring** TCC permission (`kIOHIDRequestTypeListenEvent`) — a
//! *different* bucket from the Accessibility permission
//! `macos_accessibility.rs` handles for *injecting* keystrokes. Auto-expansion
//! needs both: Input Monitoring to see the keyword typed, Accessibility to
//! delete it and paste the expansion.
//!
//! Worked from the documented, stable `IOKit`/`IOHIDLib` C API directly (the
//! same hand-rolled-FFI discipline as `macos_accessibility.rs`), rather than a
//! higher-level crate, so it stays cross-compile-checkable on the Linux dev
//! box.

// `IOHIDRequestType` values (IOKit/hid/IOHIDLib.h).
const K_IOHID_REQUEST_TYPE_LISTEN_EVENT: u32 = 1;
// `IOHIDAccessType` values.
const K_IOHID_ACCESS_TYPE_GRANTED: u32 = 0;

#[link(name = "IOKit", kind = "framework")]
unsafe extern "C" {
    /// Returns the current access level for the given request type without
    /// prompting — safe to poll.
    fn IOHIDCheckAccess(request: u32) -> u32;
    /// Requests access for the given request type, showing the system prompt
    /// (and adding the app to the Input Monitoring list) the first time.
    /// Returns whether access is granted.
    fn IOHIDRequestAccess(request: u32) -> bool;
}

/// Whether OpenRay may currently listen to HID (keyboard) events — a cheap,
/// non-prompting check, safe to call from a hot path.
pub fn is_trusted() -> bool {
    unsafe { IOHIDCheckAccess(K_IOHID_REQUEST_TYPE_LISTEN_EVENT) == K_IOHID_ACCESS_TYPE_GRANTED }
}

/// Returns whether OpenRay is trusted for Input Monitoring, prompting with the
/// system dialog (which links to the right System Settings pane) if it isn't.
/// Like `macos_accessibility::ensure_trusted_with_prompt`, the OS shows the
/// dialog once per app per permission state; a fresh grant only takes effect
/// after the app is relaunched, so a first enable typically reports `false`
/// and the user re-toggles once they've granted it.
pub fn ensure_trusted_with_prompt() -> bool {
    if is_trusted() {
        return true;
    }
    unsafe { IOHIDRequestAccess(K_IOHID_REQUEST_TYPE_LISTEN_EVENT) }
}
