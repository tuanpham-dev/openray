//! Multi-format clipboard writes on macOS, via `NSPasteboard` +
//! `NSPasteboardItem` — one item carrying several representations
//! (`NSPasteboardTypePNG`, `NSPasteboardTypeFileURL`,
//! `NSPasteboardTypeString`) written in one `writeObjects:` call, which is
//! how Finder itself offers a copied file (image data for image editors,
//! a file reference for file managers, the path as text for anything
//! else).
//!
//! Unverified on real hardware — this dev machine is Linux — see the
//! plan's Open Questions (`plans/auto-paste-format.md`). Written directly
//! against the documented, stable AppKit APIs, following
//! `platform/ocr/macos.rs`'s precedent of typed `objc2-*` crate calls
//! over raw `msg_send!`. Feature-name correctness for `objc2-app-kit`/
//! `objc2-foundation` is checked by this repo's CI `platform-check` job
//! (`cargo check --target aarch64-apple-darwin`); method/argument
//! correctness beyond that needs a real Mac.
//!
//! Unlike the X11 backend, `NSPasteboardItem`'s representations are all
//! set before `writeObjects:` is called, so `Payload::LazyPngFromFile` is
//! decoded and PNG-encoded here up front rather than on first request —
//! same reasoning as the Wayland backend.

use std::ffi::c_void;
use std::path::Path;

use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2_app_kit::{
    NSPasteboard, NSPasteboardItem, NSPasteboardType, NSPasteboardTypeFileURL, NSPasteboardTypePNG,
    NSPasteboardTypeString, NSPasteboardWriting,
};
use objc2_foundation::{NSArray, NSData, NSString};

use super::{OfferEntry, Payload};

pub fn set_offer(entries: Vec<OfferEntry>) -> Result<(), String> {
    let item = build_item(entries)?;

    let pasteboard = NSPasteboard::generalPasteboard();
    pasteboard.clearContents();
    let objects: Retained<NSArray<ProtocolObject<dyn NSPasteboardWriting>>> =
        NSArray::from_slice(&[ProtocolObject::from_ref(&*item)]);
    if pasteboard.writeObjects(&objects) {
        Ok(())
    } else {
        Err("NSPasteboard writeObjects: returned false".to_string())
    }
}

/// Builds one `NSPasteboardItem` carrying whichever of PNG/file-URL/plain-
/// text representations `entries` offers — entries with no macOS
/// equivalent (X11 atoms, GNOME's `x-special/gnome-copied-files`) are
/// simply not represented, same as the Wayland backend dropping
/// X11-only targets.
fn build_item(entries: Vec<OfferEntry>) -> Result<Retained<NSPasteboardItem>, String> {
    let item = NSPasteboardItem::new();

    for entry in entries {
        let (pasteboard_type, is_binary): (&NSPasteboardType, bool) = match entry.target.as_str() {
            "image/png" => (png_type(), true),
            "text/uri-list" => (file_url_type(), false),
            "UTF8_STRING" | "text/plain" | "text/plain;charset=utf-8" => (string_type(), false),
            _ => continue,
        };

        let ok = match entry.payload {
            Payload::Bytes(bytes) => set_representation(&item, &bytes, pasteboard_type, is_binary),
            Payload::LazyPngFromFile(path) => {
                set_representation(&item, &encode_png(&path)?, pasteboard_type, is_binary)
            }
        };
        if !ok {
            return Err(format!("NSPasteboardItem could not set a representation for '{}'", entry.target));
        }
    }

    Ok(item)
}

/// `text/uri-list`/`UTF8_STRING`-family targets carry UTF-8 text bytes
/// that map cleanly onto `setString:forType:`; `image/png` (`is_binary`)
/// is written as raw `NSData` via `setData:forType:`. Both are "set a
/// representation" from the caller's point of view, so this hides the
/// choice behind one bool-returning call.
fn set_representation(item: &NSPasteboardItem, bytes: &[u8], pasteboard_type: &NSPasteboardType, is_binary: bool) -> bool {
    if is_binary {
        // SAFETY: `bytes.as_ptr()` is valid for `bytes.len()` bytes for
        // the duration of this call; `dataWithBytes:length:` copies them.
        let data = unsafe { NSData::dataWithBytes_length(bytes.as_ptr() as *const c_void, bytes.len()) };
        item.setData_forType(&data, pasteboard_type)
    } else {
        let Ok(text) = std::str::from_utf8(bytes) else { return false };
        item.setString_forType(&NSString::from_str(text), pasteboard_type)
    }
}

// `NSPasteboardType*Foo` constants are `extern "C"` statics — referencing
// them is `unsafe` per Rust's rules for any extern static, regardless of
// mutability. AppKit initializes them before any Objective-C code (ours
// included) can run, so reading them is always sound.
fn png_type() -> &'static NSPasteboardType {
    unsafe { NSPasteboardTypePNG }
}

fn file_url_type() -> &'static NSPasteboardType {
    unsafe { NSPasteboardTypeFileURL }
}

fn string_type() -> &'static NSPasteboardType {
    unsafe { NSPasteboardTypeString }
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
