//! `Windows.Media.Ocr` backend — built into the OS, no bundled models.
//!
//! Every call here is wrapped in `run_on_mta_thread` below rather than
//! called directly. `IAsyncOperation::get()` (used throughout) blocks
//! until a completion callback fires, and delivering that callback onto
//! an STA thread requires that thread's message pump to be running.
//! Rust's own `std::thread::spawn` doesn't initialize COM at all, and the
//! thread this previously ran on — `screenshots.rs`'s background sweep
//! thread — is exactly such a thread: no pump, so a `.get()` call there
//! deadlocks forever waiting for a callback that can never be delivered.
//! A sibling project hit this exact deadlock (its own OCR module has a
//! detailed write-up); the fix is the same one it uses: run the actual
//! recognition on a fresh thread explicitly `CoInitializeEx`'d as MTA,
//! where completions signal a plain event with no message-pump
//! requirement, so `.get()` just waits and returns normally. Unverified
//! end-to-end on real hardware — this dev machine is macOS — but the
//! deadlock this fixes, and the fix itself, are both documented,
//! previously-encountered, not speculative.

use std::path::Path;
use std::sync::OnceLock;

use windows::core::HSTRING;
use windows::Graphics::Imaging::BitmapDecoder;
use windows::Media::Ocr::OcrEngine;
use windows::Storage::{FileAccessMode, StorageFile};
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

const ENGINE_NAME: &str = "Windows OCR";

/// `TryCreateFromUserProfileLanguages` returns null when no installed
/// language pack has OCR support — cached since engine creation isn't
/// free and `available()`/`extract_text` both need the answer. Engine
/// creation is itself a WinRT call, so this also only ever happens on the
/// MTA worker thread, not whatever thread first calls `available()`.
fn engine() -> Option<&'static OcrEngine> {
    static ENGINE: OnceLock<Option<OcrEngine>> = OnceLock::new();
    ENGINE.get_or_init(|| run_on_mta_thread(|| OcrEngine::TryCreateFromUserProfileLanguages().ok().flatten())).as_ref()
}

pub fn available() -> bool {
    engine().is_some()
}

pub fn engine_name() -> &'static str {
    ENGINE_NAME
}

pub fn extract_text(path: &Path) -> Option<String> {
    let path = path.to_path_buf();
    run_on_mta_thread(move || {
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
    })
}

/// Runs `work` on a fresh thread initialized as MTA — see the module doc
/// for why this, and not the calling thread, is where every WinRT call in
/// this file has to happen. Returns `None` if the worker thread panics
/// too, matching this whole module's "degrade, never error" contract —
/// `T` and the closure are `Send` so this compiles for any caller; every
/// actual use here only ever crosses `&'static OcrEngine`/`String`.
fn run_on_mta_thread<T: Send + 'static>(work: impl FnOnce() -> Option<T> + Send + 'static) -> Option<T> {
    std::thread::spawn(move || {
        // SAFETY: `CoUninitialize` is called before this thread exits,
        // matching this `CoInitializeEx` exactly once, on the same thread.
        let init = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        let result = work();
        if init.is_ok() {
            unsafe { CoUninitialize() };
        }
        result
    })
    .join()
    .unwrap_or(None)
}
