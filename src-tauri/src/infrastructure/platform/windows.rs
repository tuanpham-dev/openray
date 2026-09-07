use std::collections::HashSet;
use std::fs;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use lnk::encoding::WINDOWS_1252;
use lnk::ShellLink;
use windows::core::PCWSTR;
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAPINFO, BITMAP,
    DIB_RGB_COLORS,
};
use windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
use windows::Win32::UI::Shell::{ExtractIconExW, SHGetFileInfoW, ShellExecuteW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON};
use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO, SW_SHOWNORMAL};

use crate::domain::ports::{AppScanner, InstalledApp};

const RESCAN_INTERVAL: Duration = Duration::from_secs(5 * 60);

struct Shortcut {
    lnk_path: String,
    name: String,
}

pub struct WindowsAppScanner {
    cache: Arc<RwLock<Vec<Shortcut>>>,
}

impl WindowsAppScanner {
    pub fn new() -> Self {
        let cache = Arc::new(RwLock::new(scan_shortcuts()));

        let background_cache = Arc::clone(&cache);
        std::thread::spawn(move || loop {
            std::thread::sleep(RESCAN_INTERVAL);
            *background_cache.write().unwrap() = scan_shortcuts();
        });

        Self { cache }
    }
}

impl Default for WindowsAppScanner {
    fn default() -> Self {
        Self::new()
    }
}

impl AppScanner for WindowsAppScanner {
    fn scan(&self) -> Vec<InstalledApp> {
        self.cache
            .read()
            .unwrap()
            .iter()
            .map(|shortcut| InstalledApp {
                id: shortcut.lnk_path.clone(),
                name: shortcut.name.clone(),
                icon: extract_icon(&shortcut.lnk_path),
            })
            .collect()
    }

    fn launch(&self, app_id: &str) -> Result<(), String> {
        let cache = self.cache.read().unwrap();
        let shortcut = cache
            .iter()
            .find(|s| s.lnk_path == app_id)
            .ok_or_else(|| format!("unknown app '{app_id}'"))?;

        let target = ShellLink::open(&shortcut.lnk_path, WINDOWS_1252)
            .ok()
            .and_then(|link| link.link_target())
            .unwrap_or_else(|| shortcut.lnk_path.clone());

        let target_wide: Vec<u16> = target.encode_utf16().chain(std::iter::once(0)).collect();

        let result = unsafe {
            ShellExecuteW(
                None,
                PCWSTR::null(),
                PCWSTR(target_wide.as_ptr()),
                PCWSTR::null(),
                PCWSTR::null(),
                SW_SHOWNORMAL,
            )
        };

        if result.0 as isize > 32 {
            Ok(())
        } else {
            Err(format!("ShellExecuteW failed for '{target}'"))
        }
    }
}

/// The two Start Menu roots, built component by component so every path
/// under them is backslash-separated throughout. Joining the literal
/// `"Microsoft/Windows/Start Menu/Programs"` kept its forward slashes in
/// the resulting path, which plain file APIs accept but the Shell
/// namespace parser behind `SHGetFileInfoW` rejects outright — every
/// icon lookup returned zero, for every app, while `fs::read_dir` and
/// launching (which goes by the resolved target, not this path) worked
/// fine. Found live: the first place a Start Menu path met a Shell API.
fn shortcut_dirs() -> Vec<PathBuf> {
    ["ProgramData", "APPDATA"]
        .into_iter()
        .filter_map(|var| std::env::var(var).ok())
        .map(|root| PathBuf::from(root).join("Microsoft").join("Windows").join("Start Menu").join("Programs"))
        .collect()
}

fn scan_shortcuts() -> Vec<Shortcut> {
    let mut shortcuts = Vec::new();
    let mut seen_paths = HashSet::new();

    for dir in shortcut_dirs() {
        collect_shortcuts_recursive(&dir, &mut shortcuts, &mut seen_paths);
    }

    shortcuts.sort_by(|a, b| a.name.cmp(&b.name));
    shortcuts
}

fn collect_shortcuts_recursive(dir: &PathBuf, out: &mut Vec<Shortcut>, seen_paths: &mut HashSet<String>) {
    let Ok(read_dir) = fs::read_dir(dir) else {
        return;
    };

    for entry in read_dir.flatten() {
        let path = entry.path();

        if path.is_dir() {
            collect_shortcuts_recursive(&path, out, seen_paths);
            continue;
        }

        if path.extension().and_then(|e| e.to_str()) != Some("lnk") {
            continue;
        }

        let Some(path_str) = path.to_str().map(String::from) else {
            continue;
        };

        if !seen_paths.insert(path_str.clone()) {
            continue;
        }

        let Some(name) = path.file_stem().and_then(|s| s.to_str()).map(String::from) else {
            continue;
        };

        out.push(Shortcut { lnk_path: path_str, name });
    }
}

/// `SHGetFileInfoW` with `SHGFI_ICON` is documented to require COM
/// initialized on the calling thread ("be sure that COM is initialized
/// before calling SHGetFileInfo"), and `scan()` runs on whatever
/// thread-pool worker Tauri hands the search to, where nothing else has.
///
/// Once per thread, matching the once-per-apartment contract
/// `CoInitializeEx` itself enforces — a second call on the same thread is
/// at best a harmless no-op (`S_FALSE`) and at worst `RPC_E_CHANGED_MODE`
/// if something else on it already picked the other apartment type, so
/// this only ever calls it the first time. Never uninitialized: `scan()`
/// runs on a long-lived thread-pool worker, not a thread this owns the
/// lifetime of, so there is no right moment to call `CoUninitialize` at —
/// the apartment simply lives as long as the thread does, same tradeoff
/// `ocr/windows.rs` documents for its own `CoInitializeEx` call.
fn ensure_com_initialized() {
    thread_local! {
        static INITIALIZED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    }
    INITIALIZED.with(|initialized| {
        if !initialized.get() {
            // SAFETY: called at most once per thread, before any other COM
            // usage on it (this module's only COM-touching call), and
            // never paired with `CoUninitialize`, matching the module doc
            // comment above.
            let _ = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
            initialized.set(true);
        }
    });
}

/// The shortcut's own icon, as a PNG cached under a stable path keyed on
/// the `.lnk`'s own path — mirrors `macos.rs`'s `resolve_and_convert_icon`
/// caching (same `$TEMP/openray-icons` directory, already in the asset
/// protocol's scope in `tauri.conf.json`, so the frontend can load either
/// platform's icons the same way).
///
/// Which icon that is — the app's own, not the badged shortcut one — is
/// `icon_for_shortcut`'s job.
fn extract_icon(lnk_path: &str) -> Option<String> {
    ensure_com_initialized();

    let cache_dir = std::env::temp_dir().join("openray-icons");
    fs::create_dir_all(&cache_dir).ok()?;

    let mut hasher = DefaultHasher::new();
    lnk_path.hash(&mut hasher);
    let png_path = cache_dir.join(format!("{:x}.png", hasher.finish()));

    if png_path.exists() {
        return png_path.to_str().map(String::from);
    }

    let hicon = icon_for_shortcut(lnk_path)?;
    // SAFETY: `hicon` was just handed back as a valid, owned handle, and is
    // destroyed exactly once, after every use of it below.
    let rgba = unsafe { icon_to_rgba(hicon) };
    unsafe { let _ = DestroyIcon(hicon); }

    let (width, height, pixels) = rgba?;
    let img = image::RgbaImage::from_raw(width, height, pixels)?;
    img.save(&png_path).ok()?;
    png_path.to_str().map(String::from)
}

/// The icon a shortcut stands for, without the link-arrow badge: asking
/// the Shell for the `.lnk` file's icon returns it as Explorer presents
/// the *file* — badge painted on — so this resolves the way the Shell
/// resolves it and stops one step short. The shortcut's own icon location
/// if it sets one (Start Menu entries often point at a `.ico` or a DLL
/// resource), else its target's first icon, and only as a last resort the
/// badged icon of the `.lnk` itself — still better than a letter.
///
/// Owned handle: the caller must `DestroyIcon` it.
fn icon_for_shortcut(lnk_path: &str) -> Option<HICON> {
    // `ShellLink::link_target` `expect`s fields some shortcuts don't carry
    // (an advertised MSI shortcut, for one), and a panic here would take
    // the whole scan — every app row — down with that one entry.
    let link = std::panic::catch_unwind(|| {
        let link = ShellLink::open(lnk_path, WINDOWS_1252).ok()?;
        let icon = link
            .string_data()
            .icon_location()
            .clone()
            .filter(|location| !location.is_empty())
            .map(|location| (expand_env(&location), *link.header().icon_index()));
        Some((icon, link.link_target()))
    })
    .ok()
    .flatten();

    if let Some((icon_location, target)) = link {
        if let Some((path, index)) = icon_location {
            if let Some(icon) = extract_icon_from(&path, index) {
                return Some(icon);
            }
        }
        if let Some(target) = target {
            if let Some(icon) = extract_icon_from(&target, 0).or_else(|| shell_icon(&target)) {
                return Some(icon);
            }
        }
    }
    shell_icon(lnk_path)
}

/// `%VAR%` references, the form shortcut icon locations come in
/// (`%SystemRoot%\system32\shell32.dll`). A variable that isn't set is
/// left exactly as written, as `ExpandEnvironmentStrings` leaves it.
fn expand_env(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    let mut rest = path;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let Some(end) = after.find('%') else {
            out.push_str(&rest[start..]);
            return out;
        };
        let name = &after[..end];
        match std::env::var(name) {
            Ok(value) => out.push_str(&value),
            Err(_) => {
                out.push('%');
                out.push_str(name);
                out.push('%');
            }
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    out
}

/// Icon `index` of an executable, DLL or `.ico` — a negative index names
/// a resource id, as `ExtractIconExW` defines it. `None` when there is no
/// such icon, or the file isn't something icons are extracted from.
fn extract_icon_from(path: &str, index: i32) -> Option<HICON> {
    let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    let mut large = HICON(std::ptr::null_mut());
    // SAFETY: `large` is a valid out-pointer for exactly the one icon
    // asked for; the path is a NUL-terminated buffer live for the call.
    let count = unsafe { ExtractIconExW(PCWSTR(wide.as_ptr()), index, Some(&mut large), None, 1) };
    (count != 0 && count != u32::MAX && !large.is_invalid()).then_some(large)
}

/// The icon the Shell shows for `path`, whatever kind of file it is.
fn shell_icon(path: &str) -> Option<HICON> {
    let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    let mut info = SHFILEINFOW::default();
    // SAFETY: `info` is a valid out-pointer of the size passed; the path
    // is a NUL-terminated buffer live for the call.
    let has_icon = unsafe {
        SHGetFileInfoW(
            PCWSTR(wide.as_ptr()),
            FILE_FLAGS_AND_ATTRIBUTES::default(),
            Some(&mut info),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON,
        )
    };
    (has_icon != 0 && !info.hIcon.is_invalid()).then_some(info.hIcon)
}

/// Reads `hicon`'s color plane into top-down RGBA pixels, `(width, height,
/// bytes)`. `None` for an icon with no color plane at all (a legacy
/// monochrome-only icon — `hbmColor` is null) or if any GDI call fails.
///
/// SAFETY: `hicon` must be a valid, non-destroyed icon handle for the
/// duration of this call.
unsafe fn icon_to_rgba(hicon: HICON) -> Option<(u32, u32, Vec<u8>)> {
    let mut icon_info = ICONINFO::default();
    GetIconInfo(hicon, &mut icon_info).ok()?;
    // Both bitmaps are ours to free once read, regardless of outcome.
    let hbm_mask = icon_info.hbmMask;
    let hbm_color = icon_info.hbmColor;

    let result = (|| {
        if hbm_color.is_invalid() {
            return None;
        }

        let mut bitmap = BITMAP::default();
        let written = GetObjectW(hbm_color.into(), std::mem::size_of::<BITMAP>() as i32, Some((&mut bitmap as *mut BITMAP).cast()));
        if written == 0 || bitmap.bmWidth <= 0 || bitmap.bmHeight <= 0 {
            return None;
        }
        let (width, height) = (bitmap.bmWidth, bitmap.bmHeight);

        let screen_dc = GetDC(None);
        let mem_dc = CreateCompatibleDC(Some(screen_dc));

        let mut bitmap_info = BITMAPINFO::default();
        bitmap_info.bmiHeader.biSize = std::mem::size_of_val(&bitmap_info.bmiHeader) as u32;
        bitmap_info.bmiHeader.biWidth = width;
        // Negative height asks GDI for a top-down DIB, matching the
        // top-down row order `image::RgbaImage::from_raw` expects — the
        // alternative is flipping the buffer ourselves after a bottom-up
        // read.
        bitmap_info.bmiHeader.biHeight = -height;
        bitmap_info.bmiHeader.biPlanes = 1;
        bitmap_info.bmiHeader.biBitCount = 32;
        bitmap_info.bmiHeader.biCompression = 0; // BI_RGB

        let mut buffer = vec![0u8; (width as usize) * (height as usize) * 4];
        let lines = GetDIBits(mem_dc, hbm_color, 0, height as u32, Some(buffer.as_mut_ptr().cast()), &mut bitmap_info, DIB_RGB_COLORS);

        let _ = DeleteDC(mem_dc);
        ReleaseDC(None, screen_dc);

        if lines == 0 {
            return None;
        }

        // GDI hands back BGRA; `image::RgbaImage` wants RGBA.
        for pixel in buffer.chunks_exact_mut(4) {
            pixel.swap(0, 2);
        }
        Some((width as u32, height as u32, buffer))
    })();

    let _ = DeleteObject(hbm_mask.into());
    let _ = DeleteObject(hbm_color.into());
    result
}

#[cfg(test)]
mod tests {
    use super::expand_env;

    #[test]
    fn expands_a_set_variable_in_place() {
        let root = std::env::var("SystemRoot").expect("SystemRoot is always set on Windows");
        assert_eq!(expand_env(r"%SystemRoot%\system32\shell32.dll"), format!(r"{root}\system32\shell32.dll"));
    }

    #[test]
    fn leaves_an_unset_variable_and_a_stray_percent_as_written() {
        assert_eq!(expand_env(r"%OPENRAY_SURELY_UNSET_VAR%\x.ico"), r"%OPENRAY_SURELY_UNSET_VAR%\x.ico");
        assert_eq!(expand_env(r"C:\50%\done"), r"C:\50%\done");
        assert_eq!(expand_env(r"C:\plain\path.exe"), r"C:\plain\path.exe");
    }
}
