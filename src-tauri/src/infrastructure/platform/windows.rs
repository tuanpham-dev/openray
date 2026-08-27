use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use lnk::encoding::WINDOWS_1252;
use lnk::ShellLink;
use windows::core::PCWSTR;
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

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
                icon: None,
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

fn shortcut_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    if let Ok(program_data) = std::env::var("ProgramData") {
        dirs.push(PathBuf::from(program_data).join("Microsoft/Windows/Start Menu/Programs"));
    }

    if let Ok(app_data) = std::env::var("APPDATA") {
        dirs.push(PathBuf::from(app_data).join("Microsoft/Windows/Start Menu/Programs"));
    }

    dirs
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
