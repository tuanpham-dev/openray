//! Multi-format clipboard writes — Screenshots' "Auto" paste format.
//! Offers several representations of the same file at once (image
//! pixels, a file reference, the plain path) so whichever a paste
//! target asks for, it gets something useful — matching how a file
//! manager's own copy works (copy a file in Thunar, paste into Mousepad,
//! get the path as text).
//!
//! Dispatched by platform exactly like `platform::ocr`. Every backend is
//! best-effort: any `Err` here means the caller (`ScreenshotsProvider::
//! copy_path_as` in `application::screenshots`) falls back to arboard's
//! ordinary single-format write, so this module never has to be the only
//! way content lands on the clipboard.

#[cfg(target_os = "linux")]
mod wayland;
#[cfg(target_os = "linux")]
mod x11;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

use std::path::{Path, PathBuf};

/// One representation to offer under a MIME/target name.
#[derive(Debug, Clone)]
pub struct OfferEntry {
    pub target: String,
    pub payload: Payload,
}

#[derive(Debug, Clone)]
pub enum Payload {
    Bytes(Vec<u8>),
    /// Decoded and PNG-encoded only when a paste target actually asks
    /// for this entry — avoids delaying the paste keystroke for a large
    /// non-PNG source image. Only meaningful to the X11 backend, which
    /// serves requests asynchronously; the Wayland/macOS/Windows
    /// backends materialize it up front since their write APIs want the
    /// bytes at claim time regardless.
    LazyPngFromFile(PathBuf),
}

#[cfg(target_os = "linux")]
pub fn set_offer(entries: Vec<OfferEntry>) -> Result<(), String> {
    if crate::infrastructure::session_env::is_wayland() {
        wayland::set_offer(entries)
    } else {
        x11::set_offer(entries)
    }
}

#[cfg(target_os = "macos")]
pub fn set_offer(entries: Vec<OfferEntry>) -> Result<(), String> {
    macos::set_offer(entries)
}

#[cfg(target_os = "windows")]
pub fn set_offer(entries: Vec<OfferEntry>) -> Result<(), String> {
    windows::set_offer(entries)
}

/// Percent-encodes `path` into a `file://` URI per RFC 3986's unreserved
/// set (plus `/` as the path separator) — the `text/uri-list` entry
/// every backend offers.
pub fn path_to_file_uri(path: &Path) -> String {
    fn is_unreserved(b: u8) -> bool {
        b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~' | b'/')
    }

    let mut uri = String::from("file://");
    for &b in path.as_os_str().as_encoded_bytes() {
        if is_unreserved(b) {
            uri.push(b as char);
        } else {
            uri.push_str(&format!("%{b:02X}"));
        }
    }
    uri
}

/// The `x-special/gnome-copied-files` payload Nautilus/Thunar read to
/// perform a real file *copy* (not just reference the path) on paste.
pub fn gnome_copied_files_payload(uri: &str) -> Vec<u8> {
    format!("copy\n{uri}").into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_to_file_uri_percent_encodes_reserved_bytes() {
        assert_eq!(path_to_file_uri(Path::new("/tmp/a b.png")), "file:///tmp/a%20b.png");
        assert_eq!(path_to_file_uri(Path::new("/tmp/a#b.png")), "file:///tmp/a%23b.png");
    }

    #[test]
    fn path_to_file_uri_percent_encodes_utf8_bytes() {
        assert_eq!(path_to_file_uri(Path::new("/tmp/café.png")), "file:///tmp/caf%C3%A9.png");
    }

    #[test]
    fn path_to_file_uri_leaves_unreserved_ascii_alone() {
        assert_eq!(path_to_file_uri(Path::new("/tmp/a-b_c.d~e.png")), "file:///tmp/a-b_c.d~e.png");
    }

    #[test]
    fn gnome_copied_files_payload_is_copy_verb_plus_uri() {
        assert_eq!(gnome_copied_files_payload("file:///tmp/a.png"), b"copy\nfile:///tmp/a.png");
    }

}
