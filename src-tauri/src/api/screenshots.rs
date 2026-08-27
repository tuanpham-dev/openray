/// Which OCR engine (if any) is available on this platform — drives the
/// Screenshots settings pane's status line.
#[tauri::command]
pub fn screenshot_ocr_status() -> Option<String> {
    crate::infrastructure::platform::ocr::available().then(|| crate::infrastructure::platform::ocr::engine_name().to_string())
}
