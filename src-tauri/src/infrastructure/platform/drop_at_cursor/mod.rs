//! "Drop at Cursor" — delivers a screenshot file to whatever window is
//! under the mouse pointer as a real OS-level drag-and-drop drop,
//! synthesizing the XDND protocol exchange rather than requiring an
//! actual mouse-drag gesture. Lets the user park the cursor over a
//! browser upload dropzone (or Slack, or a file manager), open the
//! palette, and drop a screenshot there without ever picking up the
//! mouse.
//!
//! Validated against a real Chrome dropzone before implementation (see
//! `plans/drop-at-cursor.md`): a synthesized `XdndEnter`/`Position`/
//! `Drop` sequence with zero pointer motion delivered a genuine `File`
//! object to the page's `drop` event — correct name, MIME type, and byte
//! count. Chrome replied `XdndStatus` with the "accepted" bit unset and
//! sent `XdndFinished` the same way, yet still delivered the file, so the
//! X11 backend treats "we served the selection" as success independent
//! of whatever the status/finished bits claim.
//!
//! X11-only — XDND has no equivalent on Wayland (no cross-client input
//! synthesis without a compositor-specific protocol none of the target
//! compositors implement), nor on macOS/Windows (their native
//! drag-and-drop APIs need a live drag session, not a one-shot
//! synthesis). `supported()` reports this so callers can omit the
//! feature entirely rather than exposing an action that always errors.

#[cfg(target_os = "linux")]
mod x11;

use std::path::Path;

#[cfg(target_os = "linux")]
pub fn supported() -> bool {
    !crate::infrastructure::session_env::is_wayland()
}

#[cfg(not(target_os = "linux"))]
pub fn supported() -> bool {
    false
}

#[cfg(target_os = "linux")]
pub fn drop_file_at_cursor(path: &Path) -> Result<(), String> {
    if crate::infrastructure::session_env::is_wayland() {
        return Err("drop at cursor is only supported on X11".to_string());
    }
    x11::drop_file_at_cursor(path)
}

#[cfg(not(target_os = "linux"))]
pub fn drop_file_at_cursor(_path: &Path) -> Result<(), String> {
    Err("drop at cursor is only supported on X11".to_string())
}

/// The `text/uri-list` payload an XDND target reads to obtain the dropped
/// file's path — CRLF-terminated per the XDND/RFC 2483 convention (the
/// clipboard's `text/uri-list` offer, by contrast, uses a bare `\n`;
/// XDND targets specifically expect `\r\n`).
pub fn uri_list_payload(path: &Path) -> Vec<u8> {
    let mut payload = super::clipboard_multi::path_to_file_uri(path).into_bytes();
    payload.extend_from_slice(b"\r\n");
    payload
}

/// `XdndEnter` message data: `[source, version<<24, first up-to-3 offered
/// types]`. Only one type is ever offered, so the "more than 3 types,
/// see XdndTypeList" flag (bit 0 of the version word) never needs to be
/// set, and slots 3/4 stay zero.
pub fn enter_data(source: u32, version: u32, uri_list_atom: u32) -> [u32; 5] {
    [source, version << 24, uri_list_atom, 0, 0]
}

/// `XdndPosition` message data: `[source, reserved, (x<<16)|y, timestamp,
/// action]`. `x`/`y` are root-window coordinates, packed the same way
/// `QueryPointer`'s reply reports them (`i16`, two's-complement into each
/// 16-bit half) — relevant for multi-monitor setups with a monitor left
/// of the origin.
pub fn position_data(source: u32, x: i16, y: i16, action_atom: u32) -> [u32; 5] {
    let packed = ((x as u16 as u32) << 16) | (y as u16 as u32);
    [source, 0, packed, 0, action_atom]
}

/// `XdndDrop` message data: `[source, reserved, timestamp, 0, 0]`.
pub fn drop_data(source: u32) -> [u32; 5] {
    [source, 0, 0, 0, 0]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn uri_list_payload_is_crlf_terminated() {
        assert_eq!(uri_list_payload(&PathBuf::from("/tmp/a.png")), b"file:///tmp/a.png\r\n");
    }

    #[test]
    fn enter_data_packs_source_version_and_first_type() {
        assert_eq!(enter_data(42, 5, 99), [42, 5 << 24, 99, 0, 0]);
    }

    #[test]
    fn position_data_packs_coordinates_into_one_word() {
        assert_eq!(position_data(42, 100, 200, 7), [42, 0, (100u32 << 16) | 200, 0, 7]);
    }

    #[test]
    fn position_data_preserves_negative_coordinates_as_two_complement() {
        assert_eq!(position_data(42, -10, 5, 7), [42, 0, (0xFFF6u32 << 16) | 5, 0, 7]);
    }

    #[test]
    fn drop_data_carries_only_the_source() {
        assert_eq!(drop_data(42), [42, 0, 0, 0, 0]);
    }
}
