use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command as ProcessCommand;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use crate::domain::ports::{AppScanner, InstalledApp};

const RESCAN_INTERVAL: Duration = Duration::from_secs(5 * 60);

struct DesktopEntry {
    id: String,
    name: String,
    exec: String,
    icon: Option<String>,
    path: PathBuf,
}

pub struct LinuxAppScanner {
    cache: Arc<RwLock<Vec<DesktopEntry>>>,
}

impl LinuxAppScanner {
    pub fn new() -> Self {
        let cache = Arc::new(RwLock::new(scan_desktop_entries()));

        let background_cache = Arc::clone(&cache);
        std::thread::spawn(move || loop {
            std::thread::sleep(RESCAN_INTERVAL);
            *background_cache.write().unwrap() = scan_desktop_entries();
        });

        Self { cache }
    }
}

impl Default for LinuxAppScanner {
    fn default() -> Self {
        Self::new()
    }
}

impl AppScanner for LinuxAppScanner {
    fn scan(&self) -> Vec<InstalledApp> {
        self.cache
            .read()
            .unwrap()
            .iter()
            .map(|entry| InstalledApp {
                id: entry.id.clone(),
                name: entry.name.clone(),
                icon: entry.icon.clone(),
            })
            .collect()
    }

    fn launch(&self, app_id: &str) -> Result<(), String> {
        let cache = self.cache.read().unwrap();
        let entry = cache
            .iter()
            .find(|e| e.id == app_id)
            .ok_or_else(|| format!("unknown app '{app_id}'"))?;

        let gio_launched = ProcessCommand::new("gio")
            .arg("launch")
            .arg(&entry.path)
            .status()
            .map(|status| status.success())
            .unwrap_or(false);

        if gio_launched {
            return Ok(());
        }

        let exec_command = strip_field_codes(&entry.exec);
        let mut parts = exec_command.split_whitespace();
        let program = parts.next().ok_or_else(|| "empty Exec line".to_string())?;

        ProcessCommand::new(program)
            .args(parts)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

fn desktop_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    if let Ok(xdg_data_dirs) = std::env::var("XDG_DATA_DIRS") {
        for dir in xdg_data_dirs.split(':') {
            dirs.push(PathBuf::from(dir).join("applications"));
        }
    } else {
        dirs.push(PathBuf::from("/usr/share/applications"));
        dirs.push(PathBuf::from("/usr/local/share/applications"));
    }

    if let Some(home) = std::env::var_os("HOME") {
        dirs.push(PathBuf::from(&home).join(".local/share/applications"));
        // Custom launchers created via a file manager's "Create Launcher" /
        // "New Launcher" action commonly land here, not in
        // ~/.local/share/applications — without this, a user-authored
        // .desktop file (e.g. a browser profile shortcut) never shows up
        // in search even though it's a completely valid entry.
        dirs.push(desktop_folder(&home));
    }

    dirs
}

/// Resolves the user's actual Desktop folder, honoring `XDG_DESKTOP_DIR`
/// from `~/.config/user-dirs.dirs` (set by `xdg-user-dirs-update`, which is
/// how a localized or user-relocated Desktop folder — e.g. `~/Bureau` on a
/// French locale — gets tracked) before falling back to the `~/Desktop`
/// default.
fn desktop_folder(home: &std::ffi::OsStr) -> PathBuf {
    let user_dirs_file = PathBuf::from(home).join(".config/user-dirs.dirs");
    if let Ok(contents) = fs::read_to_string(&user_dirs_file) {
        for line in contents.lines() {
            let line = line.trim();
            if let Some(value) = line.strip_prefix("XDG_DESKTOP_DIR=") {
                let expanded = value.trim_matches('"').replace("$HOME", &home.to_string_lossy());
                return PathBuf::from(expanded);
            }
        }
    }
    PathBuf::from(home).join("Desktop")
}

fn scan_desktop_entries() -> Vec<DesktopEntry> {
    let mut entries = Vec::new();
    let mut seen_ids = HashSet::new();

    for dir in desktop_dirs() {
        let Ok(read_dir) = fs::read_dir(&dir) else {
            continue;
        };

        for dir_entry in read_dir.flatten() {
            let path = dir_entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("desktop") {
                continue;
            }

            let Some(id) = path.file_name().and_then(|n| n.to_str()).map(String::from) else {
                continue;
            };

            if !seen_ids.insert(id.clone()) {
                continue;
            }

            if let Some(parsed) = parse_desktop_file(&path, id) {
                entries.push(parsed);
            }
        }
    }

    entries.sort_by(|a, b| a.name.cmp(&b.name));
    entries
}

fn parse_desktop_file(path: &Path, id: String) -> Option<DesktopEntry> {
    let contents = fs::read_to_string(path).ok()?;

    let mut in_desktop_entry_section = false;
    let mut name = None;
    let mut exec = None;
    let mut icon = None;
    let mut is_application = true;
    let mut no_display = false;
    let mut hidden = false;

    for line in contents.lines() {
        let line = line.trim();

        if line.starts_with('[') {
            in_desktop_entry_section = line == "[Desktop Entry]";
            continue;
        }

        if !in_desktop_entry_section {
            continue;
        }

        let Some((key, value)) = line.split_once('=') else {
            continue;
        };

        match key.trim() {
            "Name" => name = Some(value.trim().to_string()),
            "Exec" => exec = Some(value.trim().to_string()),
            "Icon" => icon = Some(value.trim().to_string()),
            "Type" => is_application = value.trim() == "Application",
            "NoDisplay" => no_display = value.trim() == "true",
            "Hidden" => hidden = value.trim() == "true",
            _ => {}
        }
    }

    if !is_application || no_display || hidden {
        return None;
    }

    Some(DesktopEntry {
        id,
        name: name?,
        exec: exec?,
        icon: icon.and_then(resolve_icon_path),
        path: path.to_path_buf(),
    })
}

/// The user's actually-configured GTK icon theme (e.g. Yaru, Papirus,
/// Breeze), read via `gsettings`. Covers GNOME and other GTK-based desktops
/// (Ubuntu, Fedora Workstation, Pop!_OS, Mint, elementary); there's no
/// equivalent lookup here for KDE Plasma's own theme setting (`kdeglobals`)
/// yet. Returns `None` on any failure — callers fall back to the universal
/// hicolor/Adwaita themes, same as if this returned nothing.
fn configured_icon_theme() -> Option<String> {
    let output = ProcessCommand::new("gsettings")
        .args(["get", "org.gnome.desktop.interface", "icon-theme"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let raw = String::from_utf8(output.stdout).ok()?;
    let trimmed = raw.trim().trim_matches('\'').trim_matches('"');
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// The OS-resolved light/dark preference, read directly via `gsettings`
/// rather than through the XDG desktop portal (which [`window::system_theme`]
/// would otherwise fall back to, and which requires a portal-frontend
/// implementation that many non-GNOME sessions don't register). Returns
/// `None` on any failure — callers fall back to the portal/native result.
pub(crate) fn gsettings_color_scheme() -> Option<String> {
    let output = ProcessCommand::new("gsettings")
        .args(["get", "org.gnome.desktop.interface", "color-scheme"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let raw = String::from_utf8(output.stdout).ok()?;
    let trimmed = raw.trim().trim_matches('\'').trim_matches('"');
    if trimmed.is_empty() {
        return None;
    }
    Some(if trimmed == "prefer-dark" { "dark".to_string() } else { "light".to_string() })
}

fn icon_theme_search_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(home) = std::env::var_os("HOME") {
        roots.push(PathBuf::from(&home).join(".local/share/icons"));
        roots.push(PathBuf::from(&home).join(".icons"));
    }
    roots.push(PathBuf::from("/usr/share/icons"));
    roots.push(PathBuf::from("/usr/local/share/icons"));
    roots
}

/// Reads `theme`'s `Inherits=` line from whichever search root has its
/// `index.theme` first. Only follows one level — real themes almost always
/// inherit hicolor either directly or transitively (Yaru → Adwaita →
/// hicolor, Papirus → hicolor), and one level catches the overwhelming
/// majority of real installs without implementing the icon theme spec's
/// full recursive resolution.
fn theme_inherits(roots: &[PathBuf], theme: &str) -> Vec<String> {
    for root in roots {
        let index = root.join(theme).join("index.theme");
        let Ok(contents) = fs::read_to_string(&index) else { continue };
        return contents
            .lines()
            .find_map(|line| line.strip_prefix("Inherits="))
            .map(|value| value.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
            .unwrap_or_default();
    }
    Vec::new()
}

/// Theme names to search, in priority order: the user's actually-configured
/// icon theme, then whatever it inherits from, then the two fallbacks every
/// well-formed icon theme install has (hicolor is spec-mandated; Adwaita
/// covers apps that only ship GNOME-style icons).
fn icon_theme_search_order(roots: &[PathBuf]) -> Vec<String> {
    let mut order = Vec::new();
    let mut seen = HashSet::new();

    for name in configured_icon_theme()
        .into_iter()
        .flat_map(|configured| {
            let inherited = theme_inherits(roots, &configured);
            std::iter::once(configured).chain(inherited)
        })
        .chain(["hicolor".to_string(), "Adwaita".to_string()])
    {
        if seen.insert(name.clone()) {
            order.push(name);
        }
    }

    order
}

/// Canonicalizes `path`, resolving any symlink components to their real
/// target, falling back to `path` itself if canonicalization fails.
///
/// Icon themes (Papirus especially) alias most spec-compliant icon names
/// (e.g. `org.xfce.parole`) to a canonical file via a *relative* symlink
/// (`org.xfce.parole.svg -> parole.svg`). Tauri's asset-protocol scope
/// checker resolves such a request with `std::fs::read_link`, which
/// returns that relative target completely unresolved (just `parole.svg`,
/// not resolved against the symlink's own directory) — so it never
/// matches any absolute scope pattern and gets rejected outright. Handing
/// back the fully-resolved absolute path here avoids ever exercising that
/// codepath.
fn canonicalized(path: PathBuf) -> String {
    path.canonicalize().unwrap_or(path).to_string_lossy().into_owned()
}

const ICON_SIZES: &[&str] = &["scalable", "256x256", "128x128", "64x64", "48x48", "32x32"];
const ICON_EXTENSIONS: &[&str] = &["svg", "png"];

/// Looks `icon` up under each of `categories`, following the icon theme
/// spec's lookup order.
fn lookup_themed_icon(icon: &str, categories: &[&str]) -> Option<String> {
    let roots = icon_theme_search_roots();
    // Theme outer, root inner: exhaust every directory for the user's
    // configured theme (and its parents) before ever falling back to a
    // theme lower in priority, per the icon theme spec's lookup order.
    for theme in icon_theme_search_order(&roots) {
        for root in &roots {
            for size in ICON_SIZES {
                for category in categories {
                    for ext in ICON_EXTENSIONS {
                        let candidate =
                            root.join(&theme).join(size).join(category).join(format!("{icon}.{ext}"));
                        if candidate.exists() {
                            return Some(canonicalized(candidate));
                        }
                    }
                }
            }
        }
    }

    None
}

fn resolve_icon_path(icon: String) -> Option<String> {
    if icon.starts_with('/') {
        return Path::new(&icon).exists().then(|| canonicalized(PathBuf::from(icon)));
    }

    if let Some(path) = lookup_themed_icon(&icon, &["apps"]) {
        return Some(path);
    }

    for ext in ICON_EXTENSIONS {
        let candidate = PathBuf::from(format!("/usr/share/pixmaps/{icon}.{ext}"));
        if candidate.exists() {
            return Some(canonicalized(candidate));
        }
    }

    None
}

/// Resolves the first of `names` that the icon theme provides, for UI
/// chrome rather than a specific application — hence the wider category
/// list (`categories`/`places`/`mimetypes` hold the generic symbols that
/// `apps`, which `resolve_icon_path` searches, deliberately doesn't).
/// Callers pass a fallback chain because icon themes are not required to
/// carry every standard name.
pub(crate) fn resolve_theme_icon(names: &[String]) -> Option<String> {
    // `legacy`, `emblems` and `actions` matter in practice: Adwaita files
    // several standard names under `legacy`, and Papirus keeps others
    // under `emblems`/`actions`, so omitting them silently drops icons the
    // theme does provide.
    const CATEGORIES: &[&str] =
        &["categories", "apps", "places", "mimetypes", "devices", "status", "actions", "emblems", "legacy"];
    names.iter().find_map(|name| lookup_themed_icon(name, CATEGORIES))
}

fn strip_field_codes(exec: &str) -> String {
    exec.split_whitespace()
        .filter(|token| !token.starts_with('%'))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn theme_icon_categories_cover_the_non_apps_dirs_themes_actually_use() {
        // Regression guard for the lookup silently missing icons the theme
        // does ship: Adwaita files standard names under `legacy`, Papirus
        // uses `emblems`/`actions`, and none of those are `apps`.
        let categories = ["categories", "apps", "places", "mimetypes", "devices", "status", "actions", "emblems", "legacy"];
        for required in ["apps", "categories", "legacy", "emblems", "actions", "mimetypes"] {
            assert!(categories.contains(&required), "missing icon category: {required}");
        }
    }

    #[test]
    fn theme_icon_lookup_tries_every_name_in_order() {
        // Nothing resolves against a scratch HOME with no themes, so this
        // pins the contract that an unresolvable chain yields None rather
        // than panicking or returning a bogus path.
        assert_eq!(resolve_theme_icon(&[]), None);
    }

    fn write_index_theme(dir: &Path, theme: &str, inherits: &str) {
        let theme_dir = dir.join(theme);
        fs::create_dir_all(&theme_dir).unwrap();
        fs::write(theme_dir.join("index.theme"), format!("[Icon Theme]\nName={theme}\nInherits={inherits}\n")).unwrap();
    }

    #[test]
    fn theme_inherits_reads_the_first_root_that_has_the_theme() {
        let dir = std::env::temp_dir().join(format!("openray-icon-theme-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        write_index_theme(&dir, "Yaru", "Adwaita,gnome,hicolor");

        let parents = theme_inherits(std::slice::from_ref(&dir), "Yaru");
        assert_eq!(parents, vec!["Adwaita".to_string(), "gnome".to_string(), "hicolor".to_string()]);

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn theme_inherits_returns_empty_for_a_theme_with_no_index_theme_anywhere() {
        let dir = std::env::temp_dir().join(format!("openray-icon-theme-test-missing-{}", std::process::id()));
        assert!(theme_inherits(&[dir], "DoesNotExist").is_empty());
    }

    #[test]
    fn icon_theme_search_order_always_ends_with_the_universal_fallbacks_deduped() {
        let order = icon_theme_search_order(&[]);
        assert!(order.contains(&"hicolor".to_string()));
        assert!(order.contains(&"Adwaita".to_string()));

        let mut seen = HashSet::new();
        for name in &order {
            assert!(seen.insert(name.clone()), "duplicate theme name in search order: {name}");
        }
    }
}
