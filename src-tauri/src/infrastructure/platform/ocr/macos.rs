//! Vision-framework OCR backend — what Raycast itself uses on macOS, and
//! the best-quality of the three engines this feature ships.
//!
//! Unverified on real hardware — this dev machine is Linux — see the
//! plan's Open Questions. Written directly against the documented, stable
//! Vision APIs (`VNImageRequestHandler` → `VNRecognizeTextRequest` →
//! `VNRecognizedTextObservation`), following `window_manage/macos.rs`'s
//! precedent of typed `objc2-*` crate calls over raw `msg_send!`. If
//! `objc2-vision` 0.3's binding shape doesn't match this file 1:1, that
//! surfaces as a compile error in the CI `platform-check` job (which
//! `cargo check --target aarch64-apple-darwin`s this exact file) — the
//! fallback discussed during planning is hand-declared Vision externs in
//! `macos_accessibility.rs`'s style, if the typed crate turns out to be
//! too awkward to fix up from a CI failure alone.

use std::path::Path;

use objc2::rc::Retained;
use objc2::AnyThread;
use objc2_foundation::{NSArray, NSDictionary, NSString, NSURL};
use objc2_vision::{VNImageRequestHandler, VNRecognizeTextRequest, VNRequestTextRecognitionLevel};

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
    let path_str = path.to_str()?;
    let url = NSURL::fileURLWithPath(&NSString::from_str(path_str));

    let handler = unsafe { VNImageRequestHandler::initWithURL_options(VNImageRequestHandler::alloc(), &url, &NSDictionary::new()) };

    let request = VNRecognizeTextRequest::new();
    request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);

    let requests: Retained<NSArray<_>> =
        NSArray::from_retained_slice(&[Retained::into_super(Retained::into_super(request.clone()))]);
    handler.performRequests_error(&requests).ok()?;

    let observations = request.results()?;

    let mut lines = Vec::new();
    for observation in observations.iter() {
        let candidates = observation.topCandidates(1);
        if let Some(top) = candidates.iter().next() {
            let text = top.string();
            lines.push(text.to_string());
        }
    }

    if lines.is_empty() {
        None
    } else {
        Some(lines.join("\n"))
    }
}
