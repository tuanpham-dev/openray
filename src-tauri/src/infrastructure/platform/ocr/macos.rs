//! Vision-framework OCR backend — what Raycast itself uses on macOS, and
//! the best-quality of the three engines this feature ships.
//!
//! Native, not `objc2`-bound: the first version of this file used typed
//! `objc2-vision` calls, structurally identical to what's below
//! (`VNImageRequestHandler` → `performRequests:error:` → `results`), but
//! loaded the image via `VNImageRequestHandler`'s own file-URL initializer
//! (`initWithURL:options:`). On the first real macOS run of this feature,
//! that hung indefinitely (near-idle CPU — blocked, not computing) the
//! moment it touched a screenshot Vision hadn't seen before; the leading
//! theory is a macOS "Files and Folders" privacy-consent prompt that
//! Vision's own file access triggered, blocked waiting on a dialog this
//! app's non-activating palette panel may never bring to the front (see
//! `macos_panel.rs`). This version instead reads the file in plain Rust
//! (`extract_text` below) and hands Vision already-decoded bytes through a
//! tiny compiled C shim (`vision_ocr.m`, linked by `build.rs`) — Vision
//! never touches the filesystem itself, sidestepping that consent path
//! entirely. Ported from a sibling project's OCR module, which has run
//! this exact shim successfully on real hardware.

use std::ffi::{c_char, c_uchar, CStr};
use std::path::Path;

#[link(name = "openray_vision_ocr", kind = "static")]
unsafe extern "C" {
    fn tas_vision_ocr(image_bytes: *const c_uchar, len: usize, lang_bcp47: *const c_char, err_out: *mut *mut c_char) -> *mut c_char;
    fn tas_vision_free(p: *mut c_char);
}

const ENGINE_NAME: &str = "Vision";

/// Vision ships with every supported macOS version this app targets — no
/// install/permission gate the way Linux's `tesseract` PATH-probe or
/// Windows' language-pack check need.
pub fn available() -> bool {
    true
}

pub fn engine_name() -> &'static str {
    ENGINE_NAME
}

pub fn extract_text(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;

    let mut err: *mut c_char = std::ptr::null_mut();
    // SAFETY: `bytes` is valid for the duration of the call; the language
    // pointer is null (auto-detect — this app has no per-command language
    // setting to thread through); `out`/`err`, when non-null, are malloc'd
    // strings this call owns and must free via `tas_vision_free` below.
    let out = unsafe { tas_vision_ocr(bytes.as_ptr(), bytes.len(), std::ptr::null(), &mut err) };

    if out.is_null() {
        if !err.is_null() {
            let message = unsafe { CStr::from_ptr(err) }.to_string_lossy().into_owned();
            unsafe { tas_vision_free(err) };
            log::warn!("Vision OCR failed for {}: {message}", path.display());
        }
        return None;
    }

    let text = unsafe { CStr::from_ptr(out) }.to_string_lossy().into_owned();
    unsafe { tas_vision_free(out) };

    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}
