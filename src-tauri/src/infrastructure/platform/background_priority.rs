//! Lowers the calling thread's OS scheduling priority so CPU-heavy
//! background work doesn't compete evenly with the WebKit UI thread when
//! the user interacts with the app while that work is still running.
//!
//! Introduced for the Screenshots OCR sweep specifically: before handing
//! an image to `tesseract`, `platform::ocr::linux::extract_text` decodes
//! it, converts it to grayscale, and does a per-pixel dark-mode-inversion
//! check — all in-process, on the sweep's background thread, back to back
//! for up to `MAX_SWEEP_IMAGES` files. On a machine with few cores that's
//! enough sustained CPU work to visibly slow down the grid re-rendering
//! (e.g. reopening the Search Screenshots view) while a sweep is still in
//! flight — confirmed live (CPU usage measurably spikes during exactly
//! that window).

#[cfg(target_os = "linux")]
pub fn lower_current_thread_priority() {
    // On Linux/NPTL, `nice()` adjusts the *calling thread's* niceness —
    // each pthread is its own kernel scheduling entity — not the whole
    // process, so this is safe to call from inside a spawned
    // `std::thread` without touching the main/UI thread's priority.
    // Best-effort: the return value (new niceness, or -1 on error) isn't
    // worth checking here, same as this codebase's other optional
    // external-tool fallbacks.
    unsafe {
        libc::nice(10);
    }
}

#[cfg(not(target_os = "linux"))]
pub fn lower_current_thread_priority() {
    // Not implemented for macOS/Windows yet — their thread-priority
    // APIs (QoS classes / SetThreadPriority) differ enough from POSIX
    // `nice()` to need their own implementations, untestable from this
    // session. The sweep still runs on a background thread there, just
    // without this extra de-prioritization.
}
