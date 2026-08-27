//! Raycast-compatible Navigation
//! (https://manual.raycast.com/navigation): Switch Windows (T19) and
//! Search Menu Bar Items (T30), backed by the per-OS modules under
//! `infrastructure::platform::{window_list,menu_bar}`. Both features'
//! *native* command surface is gone — both are extension views now — but
//! this module's data/listing logic stays: `list_windows`/`list_menu_items`
//! are reached through `application::extension_bridge`'s `host.window.list`/
//! `host.menuBar.list` handlers instead of a native `CommandProvider`.

use serde::Serialize;

use crate::domain::ports::{AppScanner, InstalledApp};
use crate::infrastructure::platform::menu_bar::{self, RawMenuNode};
use crate::infrastructure::platform::window_list;

/// Still produced by `list_windows()` below, now called only from
/// `application::extension_bridge::window_list_windows` (T19) — the
/// native `builtin.switch-windows` command and its dedicated
/// `api::navigation::list_windows` Tauri command are gone, but the
/// underlying listing/icon-resolution logic didn't move, only its
/// caller did.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    pub id: String,
    pub title: String,
    pub app_name: String,
    pub icon: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuBarItem {
    pub token: String,
    pub title: String,
    pub path: Vec<String>,
    pub shortcut: Option<String>,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MenuBarListing {
    pub app_name: Option<String>,
    pub items: Vec<MenuBarItem>,
}

pub struct NavigationProvider {
    scanner: Box<dyn AppScanner>,
}

impl NavigationProvider {
    pub fn new(scanner: Box<dyn AppScanner>) -> Self {
        Self { scanner }
    }

    pub fn list_windows(&self) -> Vec<WindowInfo> {
        let apps = self.scanner.scan();
        window_list::list()
            .into_iter()
            .map(|w| {
                let icon = match_app_icon(&apps, &w.app_match_hint).or(w.icon);
                WindowInfo { id: w.id, title: w.title, app_name: w.app_name, icon }
            })
            .collect()
    }
}

/// `host.menuBar.list()` (T30) — a free function, not a `NavigationProvider`
/// method: unlike `list_windows` it needs no `AppScanner` (or any other
/// held state), so giving it one only to never use it would be a pointless
/// coupling to the type that used to own the (now-deleted) native command
/// this backed.
pub fn list_menu_items() -> MenuBarListing {
    let read = menu_bar::read();
    let mut items = Vec::new();
    for node in &read.nodes {
        flatten(node, &[], &mut items);
    }
    MenuBarListing { app_name: read.app_name, items }
}

/// Best-effort match of a window's identity hint (already lowercased) to
/// an installed app, for its higher-quality theme icon. Accepted as
/// approximate — see the plan's Open Questions for the tradeoff.
fn match_app_icon(apps: &[InstalledApp], hint: &str) -> Option<String> {
    if hint.is_empty() {
        return None;
    }
    apps.iter()
        .find(|app| {
            let id = app.id.trim_end_matches(".desktop").to_lowercase();
            let name = app.name.to_lowercase();
            id == hint || name == hint || normalize(&id) == normalize(hint)
        })
        .and_then(|app| app.icon.clone())
}

fn normalize(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric()).collect()
}

/// Flattens a `RawMenuNode` tree into a search-friendly list: mnemonics
/// stripped, separators and invisible/empty submenus dropped, each leaf
/// carrying its ancestor titles as `path`.
fn flatten(node: &RawMenuNode, path: &[String], out: &mut Vec<MenuBarItem>) {
    match node {
        RawMenuNode::Separator => {}
        RawMenuNode::Item { title, enabled, shortcut, token } => {
            let title = strip_mnemonic(title);
            if title.is_empty() {
                return;
            }
            out.push(MenuBarItem { token: token.clone(), title, path: path.to_vec(), shortcut: shortcut.clone(), enabled: *enabled });
        }
        RawMenuNode::Submenu { title, children, .. } => {
            let title = strip_mnemonic(title);
            if title.is_empty() {
                return;
            }
            let mut next_path = path.to_vec();
            next_path.push(title);
            for child in children {
                flatten(child, &next_path, out);
            }
        }
    }
}

/// Strips a single GTK/Win32-style mnemonic marker (`_File` / `&File`),
/// leaving an escaped literal (`__`/`&&`) alone.
fn strip_mnemonic(title: &str) -> String {
    let mut out = String::with_capacity(title.len());
    let mut chars = title.chars().peekable();
    while let Some(c) = chars.next() {
        if (c == '_' || c == '&') && chars.peek() == Some(&c) {
            out.push(chars.next().unwrap());
        } else if c == '_' || c == '&' {
            continue;
        } else {
            out.push(c);
        }
    }
    out.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(title: &str, token: &str) -> RawMenuNode {
        RawMenuNode::Item { title: title.into(), enabled: true, shortcut: None, token: token.into() }
    }

    #[test]
    fn strips_underscore_and_ampersand_mnemonics() {
        assert_eq!(strip_mnemonic("_File"), "File");
        assert_eq!(strip_mnemonic("&Edit"), "Edit");
        assert_eq!(strip_mnemonic("Save __As"), "Save _As");
    }

    #[test]
    fn flattens_nested_submenus_with_path() {
        let tree = RawMenuNode::Submenu {
            title: "File".into(),
            enabled: true,
            children: vec![
                item("New", "file.new"),
                RawMenuNode::Separator,
                RawMenuNode::Submenu { title: "Recent".into(), enabled: true, children: vec![item("doc.txt", "file.recent.0")] },
            ],
        };

        let mut out = Vec::new();
        flatten(&tree, &[], &mut out);

        assert_eq!(out.len(), 2);
        assert_eq!(out[0].title, "New");
        assert_eq!(out[0].path, vec!["File".to_string()]);
        assert_eq!(out[1].title, "doc.txt");
        assert_eq!(out[1].path, vec!["File".to_string(), "Recent".to_string()]);
    }

    #[test]
    fn disabled_items_are_kept_with_their_shortcut() {
        let tree = RawMenuNode::Submenu {
            title: "Edit".into(),
            enabled: true,
            children: vec![RawMenuNode::Item { title: "Undo".into(), enabled: false, shortcut: Some("Ctrl+Z".into()), token: "edit.undo".into() }],
        };
        let mut out = Vec::new();
        flatten(&tree, &[], &mut out);
        assert_eq!(out.len(), 1);
        assert!(!out[0].enabled);
        assert_eq!(out[0].shortcut.as_deref(), Some("Ctrl+Z"));
    }

    #[test]
    fn empty_title_after_mnemonic_strip_is_dropped() {
        let tree = item("", "empty");
        let mut out = Vec::new();
        flatten(&tree, &[], &mut out);
        assert!(out.is_empty());
    }
}
