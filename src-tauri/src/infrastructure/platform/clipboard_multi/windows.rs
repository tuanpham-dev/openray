//! Multi-format clipboard writes on Windows, via the classic Win32
//! clipboard: `OpenClipboard` → `EmptyClipboard` → one `SetClipboardData`
//! per format → `CloseClipboard`. Offers `CF_UNICODETEXT` (the path),
//! `CF_HDROP` (the path as a one-file drop list — what Explorer itself
//! puts on the clipboard for a copied file), and a registered `"PNG"`
//! format (raw PNG bytes, materialized up front — the classic clipboard
//! has no concept of "ask for it lazily").
//!
//! Unverified on real hardware — this dev machine is Linux — see the
//! plan's Open Questions (`plans/auto-paste-format.md`). Feature-name
//! correctness for the `windows` crate is checked by this repo's CI
//! `platform-check` job (`cargo check --target x86_64-pc-windows-msvc`);
//! method/argument correctness beyond that needs a real Windows machine
//! — same convention as `platform/ocr/windows.rs`.

use std::path::Path;

use windows::core::HSTRING;
use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL, POINT};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::UI::Shell::DROPFILES;

use super::{OfferEntry, Payload};

// winuser.h — not worth the `Win32_System_Ole` feature for two numbers.
const CF_UNICODETEXT: u32 = 13;
const CF_HDROP: u32 = 15;
const PNG_FORMAT_NAME: &str = "PNG";

pub fn set_offer(entries: Vec<OfferEntry>) -> Result<(), String> {
    let write = build_write(entries)?;

    // SAFETY: `OpenClipboard`/`EmptyClipboard`/`SetClipboardData`/
    // `CloseClipboard` are ordinary clipboard calls; `None` attaches the
    // clipboard to the current thread rather than a specific window,
    // which is fine for a one-shot write with no paste-request serving.
    unsafe { OpenClipboard(None) }.map_err(|e| e.to_string())?;
    let result = (|| -> Result<(), String> {
        unsafe { EmptyClipboard() }.map_err(|e| e.to_string())?;
        for (format, bytes) in write {
            set_clipboard_bytes(format, &bytes)?;
        }
        Ok(())
    })();
    // Always close, even if a write above failed partway through — an
    // open clipboard left behind blocks every other app's copy/paste
    // until this process exits.
    let _ = unsafe { CloseClipboard() };
    result
}

/// Resolves `entries` into `(format, bytes)` pairs ready for
/// `SetClipboardData` — `image/png` becomes the registered `"PNG"`
/// format, and the first plain-text entry found becomes both
/// `CF_UNICODETEXT` (as text) and `CF_HDROP` (as a one-file drop list;
/// `text/uri-list`'s percent-encoded URI isn't a real filesystem path, so
/// the plain-text entry is used for both, not the URI one). Entries with
/// no Windows equivalent (GNOME's `x-special/gnome-copied-files`) are
/// dropped, same as the Wayland/macOS backends.
fn build_write(entries: Vec<OfferEntry>) -> Result<Vec<(u32, Vec<u8>)>, String> {
    let mut path_text: Option<String> = None;
    let mut png_bytes: Option<Vec<u8>> = None;

    for entry in entries {
        match entry.target.as_str() {
            "UTF8_STRING" | "text/plain" | "text/plain;charset=utf-8" if path_text.is_none() => {
                let Payload::Bytes(bytes) = entry.payload else { continue };
                path_text = String::from_utf8(bytes).ok();
            }
            "image/png" if png_bytes.is_none() => {
                png_bytes = Some(match entry.payload {
                    Payload::Bytes(bytes) => bytes,
                    Payload::LazyPngFromFile(path) => encode_png(&path)?,
                });
            }
            _ => {}
        }
    }

    let mut write = Vec::new();
    if let Some(path) = &path_text {
        write.push((CF_UNICODETEXT, utf16_nul_bytes(path)));
        write.push((CF_HDROP, dropfiles_bytes(path)));
    }
    if let Some(bytes) = png_bytes {
        // SAFETY: no thread/window preconditions beyond an open
        // clipboard, which the caller guarantees.
        let format = unsafe { RegisterClipboardFormatW(&HSTRING::from(PNG_FORMAT_NAME)) };
        write.push((format, bytes));
    }
    Ok(write)
}

fn set_clipboard_bytes(format: u32, bytes: &[u8]) -> Result<(), String> {
    // SAFETY: `hmem` is freshly allocated below and not yet handed to
    // `SetClipboardData`, so this process still owns it; the lock/write/
    // unlock sequence is the documented pattern for populating global
    // memory before a clipboard call.
    unsafe {
        let hmem: HGLOBAL = GlobalAlloc(GMEM_MOVEABLE, bytes.len()).map_err(|e| e.to_string())?;
        let ptr = GlobalLock(hmem);
        if ptr.is_null() {
            let _ = GlobalFree(Some(hmem));
            return Err("GlobalLock returned null".to_string());
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr as *mut u8, bytes.len());
        let _ = GlobalUnlock(hmem);

        // On success the system now owns `hmem` — it must not be freed
        // here. On failure, ownership never transferred, so it's ours to
        // clean up.
        if let Err(e) = SetClipboardData(format, Some(HANDLE(hmem.0))) {
            let _ = GlobalFree(Some(hmem));
            return Err(e.to_string());
        }
    }
    Ok(())
}

fn utf16_nul_bytes(s: &str) -> Vec<u8> {
    s.encode_utf16().chain(std::iter::once(0u16)).flat_map(|unit| unit.to_le_bytes()).collect()
}

/// `CF_HDROP` payload: a `DROPFILES` header (`pFiles` = byte offset of
/// the file list, `fWide` = true since the list is UTF-16) followed by a
/// double-NUL-terminated list of file paths — one path here, so a single
/// NUL ends it and a second NUL ends the (one-entry) list.
fn dropfiles_bytes(path: &str) -> Vec<u8> {
    let header_size = std::mem::size_of::<DROPFILES>();
    let header = DROPFILES { pFiles: header_size as u32, pt: POINT::default(), fNC: false.into(), fWide: true.into() };
    // SAFETY: `DROPFILES` is `#[repr(C, packed(1))]` plain-old-data;
    // reading its bytes for a memcpy-style serialize is sound.
    let header_bytes =
        unsafe { std::slice::from_raw_parts(&header as *const DROPFILES as *const u8, header_size) };

    let mut bytes = Vec::with_capacity(header_size + (path.len() + 2) * 2);
    bytes.extend_from_slice(header_bytes);
    bytes.extend(utf16_nul_bytes(path));
    bytes.extend_from_slice(&0u16.to_le_bytes());
    bytes
}

fn encode_png(path: &Path) -> Result<Vec<u8>, String> {
    use image::ImageEncoder;

    let decoded = image::open(path).map_err(|e| e.to_string())?.to_rgba8();
    let mut bytes = Vec::new();
    image::codecs::png::PngEncoder::new(&mut bytes)
        .write_image(decoded.as_raw(), decoded.width(), decoded.height(), image::ExtendedColorType::Rgba8)
        .map_err(|e| e.to_string())?;
    Ok(bytes)
}
