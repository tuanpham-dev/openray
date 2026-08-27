//! `Windows.Media.Ocr` backend — built into the OS, no bundled models.
//!
//! Unverified on real hardware — this dev machine is Linux — see the
//! plan's Open Questions. Written directly against the documented WinRT
//! flow (`OcrEngine::TryCreateFromUserProfileLanguages` →
//! `StorageFile::GetFileFromPathAsync` → `BitmapDecoder::CreateAsync` →
//! `GetSoftwareBitmapAsync` → `RecognizeAsync`), blocking on each
//! `IAsyncOperation` with `.get()` since this runs on `screenshots.rs`'s
//! own background sweep thread, not the UI thread. Feature-name
//! correctness for the `windows` crate is checked by this repo's CI
//! `platform-check` job (`cargo check --target x86_64-pc-windows-msvc`);
//! method/argument correctness beyond that needs a real Windows machine.

use std::path::Path;
use std::sync::OnceLock;

use windows::core::HSTRING;
use windows::Graphics::Imaging::BitmapDecoder;
use windows::Media::Ocr::OcrEngine;
use windows::Storage::{FileAccessMode, StorageFile};

const ENGINE_NAME: &str = "Windows OCR";

/// `TryCreateFromUserProfileLanguages` returns null when no installed
/// language pack has OCR support — cached since engine creation isn't
/// free and `available()`/`extract_text` both need the answer.
fn engine() -> Option<&'static OcrEngine> {
    static ENGINE: OnceLock<Option<OcrEngine>> = OnceLock::new();
    ENGINE.get_or_init(|| OcrEngine::TryCreateFromUserProfileLanguages().ok().flatten()).as_ref()
}

pub fn available() -> bool {
    engine().is_some()
}

pub fn engine_name() -> &'static str {
    ENGINE_NAME
}

pub fn extract_text(path: &Path) -> Option<String> {
    let engine = engine()?;
    let path_str = path.to_str()?;

    let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(path_str)).ok()?.get().ok()?;
    let stream = file.OpenAsync(FileAccessMode::Read).ok()?.get().ok()?;
    let decoder = BitmapDecoder::CreateAsync(&stream).ok()?.get().ok()?;
    let bitmap = decoder.GetSoftwareBitmapAsync().ok()?.get().ok()?;
    let result = engine.RecognizeAsync(&bitmap).ok()?.get().ok()?;

    let text = result.Text().ok()?.to_string_lossy();
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}
