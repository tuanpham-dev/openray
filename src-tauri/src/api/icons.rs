/// Resolves a UI glyph from the desktop's icon theme, trying `names` in
/// order and returning the first the theme provides (themes aren't
/// required to carry every standard name, so callers pass a fallback
/// chain). Returns `None` when nothing matches — and always on macOS and
/// Windows, which have no freedesktop icon theme; the frontend falls back
/// to its own bundled icons.
#[tauri::command]
pub fn resolve_theme_icon(names: Vec<String>) -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        crate::infrastructure::platform::linux::resolve_theme_icon(&names)
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = names;
        None
    }
}
