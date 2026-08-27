use std::collections::HashSet;
use std::fs;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::Command as ProcessCommand;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use crate::domain::ports::{AppScanner, InstalledApp};

const RESCAN_INTERVAL: Duration = Duration::from_secs(5 * 60);

struct AppBundle {
    path: String,
    name: String,
    icon: Option<String>,
}

pub struct MacosAppScanner {
    cache: Arc<RwLock<Vec<AppBundle>>>,
}

impl MacosAppScanner {
    pub fn new() -> Self {
        let cache = Arc::new(RwLock::new(scan_app_bundles()));

        let background_cache = Arc::clone(&cache);
        std::thread::spawn(move || loop {
            std::thread::sleep(RESCAN_INTERVAL);
            *background_cache.write().unwrap() = scan_app_bundles();
        });

        Self { cache }
    }
}

impl Default for MacosAppScanner {
    fn default() -> Self {
        Self::new()
    }
}

impl AppScanner for MacosAppScanner {
    fn scan(&self) -> Vec<InstalledApp> {
        self.cache
            .read()
            .unwrap()
            .iter()
            .map(|bundle| InstalledApp {
                id: bundle.path.clone(),
                name: bundle.name.clone(),
                icon: bundle.icon.clone(),
            })
            .collect()
    }

    fn launch(&self, app_id: &str) -> Result<(), String> {
        ProcessCommand::new("open")
            .arg("-a")
            .arg(app_id)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

fn app_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![PathBuf::from("/Applications")];
    if let Some(home) = std::env::var_os("HOME") {
        dirs.push(PathBuf::from(home).join("Applications"));
    }
    dirs
}

fn scan_app_bundles() -> Vec<AppBundle> {
    let mut bundles = Vec::new();
    let mut seen_paths = HashSet::new();

    for dir in app_dirs() {
        let Ok(read_dir) = fs::read_dir(&dir) else {
            continue;
        };

        for entry in read_dir.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("app") {
                continue;
            }

            let Some(path_str) = path.to_str().map(String::from) else {
                continue;
            };

            if !seen_paths.insert(path_str.clone()) {
                continue;
            }

            if let Some(bundle) = parse_app_bundle(&path, path_str) {
                bundles.push(bundle);
            }
        }
    }

    bundles.sort_by(|a, b| a.name.cmp(&b.name));
    bundles
}

fn parse_app_bundle(path: &Path, bundle_path: String) -> Option<AppBundle> {
    let info_plist_path = path.join("Contents/Info.plist");
    let plist_value = plist::Value::from_file(&info_plist_path).ok()?;
    let dict = plist_value.as_dictionary()?;

    let fallback_name = path.file_stem()?.to_str()?.to_string();
    let name = dict
        .get("CFBundleDisplayName")
        .or_else(|| dict.get("CFBundleName"))
        .and_then(|v| v.as_string())
        .map(String::from)
        .unwrap_or(fallback_name);

    let icon = dict
        .get("CFBundleIconFile")
        .and_then(|v| v.as_string())
        .and_then(|icon_name| resolve_and_convert_icon(path, icon_name));

    Some(AppBundle { path: bundle_path, name, icon })
}

fn resolve_and_convert_icon(bundle_path: &Path, icon_name: &str) -> Option<String> {
    let icon_file = if icon_name.ends_with(".icns") {
        icon_name.to_string()
    } else {
        format!("{icon_name}.icns")
    };

    let icns_path = bundle_path.join("Contents/Resources").join(&icon_file);
    if !icns_path.exists() {
        return None;
    }

    let cache_dir = std::env::temp_dir().join("openray-icons");
    fs::create_dir_all(&cache_dir).ok()?;

    let mut hasher = DefaultHasher::new();
    icns_path.to_string_lossy().hash(&mut hasher);
    let png_path = cache_dir.join(format!("{:x}.png", hasher.finish()));

    if png_path.exists() {
        return png_path.to_str().map(String::from);
    }

    let converted = ProcessCommand::new("sips")
        .args(["-s", "format", "png"])
        .arg(&icns_path)
        .arg("--out")
        .arg(&png_path)
        .status()
        .map(|status| status.success())
        .unwrap_or(false);

    converted.then(|| png_path.to_str().map(String::from)).flatten()
}
