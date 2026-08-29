//! Menu-bar commands: a `MenuBarExtra` tree rendered into the system tray.
//!
//! Raycast gives each menu-bar extension its own tray icon, and so does
//! this — `infrastructure::tray` owns OpenRay's own icon, and this module
//! owns one further icon per extension that currently has a menu-bar
//! command mounted. 19 of 180 sampled extensions ship one.
//!
//! The host sends these as `ui.menuBar` rather than `ui.commit`, always as
//! a full snapshot (see `runner.ts`), so nothing here has to apply tree
//! diffs. Tauri exposes no incremental menu mutation either, so a commit
//! rebuilds that one icon's menu wholesale — cheap for a menu, and scoped
//! to the extension that committed rather than to a shared menu.

use std::collections::HashMap;
use std::sync::Mutex;

use serde_json::Value;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{TrayIcon, TrayIconBuilder},
    AppHandle, Manager, Runtime,
};

/// One extension's current menu-bar state.
struct MenuBarEntry {
    /// The tree as last committed — kept so the icon can be rebuilt when
    /// the tray is re-shown without asking the extension to re-render.
    snapshot: Value,
    icon: Option<TrayIcon>,
}

#[derive(Default)]
pub struct MenuBarState {
    entries: Mutex<HashMap<String, MenuBarEntry>>,
    /// Mirrors the `show_tray_icon` setting: when off, trees are retained
    /// but no icon exists, so toggling it back on doesn't require the
    /// commands to be relaunched.
    visible: Mutex<bool>,
}

impl MenuBarState {
    pub fn new(visible: bool) -> Self {
        Self { entries: Mutex::new(HashMap::new()), visible: Mutex::new(visible) }
    }
}

fn tray_id(extension_id: &str) -> String {
    format!("menu-bar:{extension_id}")
}

/// Applies one `ui.menuBar` snapshot.
pub fn commit(app: &AppHandle, extension_id: &str, snapshot: Value) {
    let Some(state) = app.try_state::<MenuBarState>() else { return };
    let visible = *state.visible.lock().unwrap();
    {
        let mut entries = state.entries.lock().unwrap();
        let entry = entries
            .entry(extension_id.to_string())
            .or_insert_with(|| MenuBarEntry { snapshot: Value::Null, icon: None });
        entry.snapshot = snapshot;
    }
    if visible {
        rebuild(app, extension_id);
    }
}

/// Drops an extension's icon — its command unmounted or was stopped.
/// Note on what "removed" means here: libayatana-appindicator has no true
/// destroy, so the item's D-Bus object outlives this call and the
/// StatusNotifierWatcher keeps listing it. What actually changes is its
/// `Status`, which goes to `Passive` — the panel then stops drawing it,
/// which is the user-visible outcome. Verified on XFCE.
pub fn remove(app: &AppHandle, extension_id: &str) {
    let Some(state) = app.try_state::<MenuBarState>() else { return };
    let mut entries = state.entries.lock().unwrap();
    if let Some(mut entry) = entries.remove(extension_id) {
        if let Some(icon) = entry.icon.take() {
            let _ = icon.set_visible(false);
        }
    }
    let _ = app.remove_tray_by_id(&tray_id(extension_id));
}

/// Shows or hides every contributed icon, following `show_tray_icon`.
///
/// Hiding keeps the trees: turning the setting back on restores the menus
/// without the user having to relaunch each command.
pub fn set_visible(app: &AppHandle, visible: bool) {
    let Some(state) = app.try_state::<MenuBarState>() else { return };
    *state.visible.lock().unwrap() = visible;
    let ids: Vec<String> = state.entries.lock().unwrap().keys().cloned().collect();
    for id in ids {
        if visible {
            rebuild(app, &id);
        } else {
            let mut entries = state.entries.lock().unwrap();
            if let Some(entry) = entries.get_mut(&id) {
                if let Some(icon) = entry.icon.take() {
                    let _ = icon.set_visible(false);
                }
            }
            drop(entries);
            let _ = app.remove_tray_by_id(&tray_id(&id));
        }
    }
}

fn nodes_of(snapshot: &Value) -> Option<(&serde_json::Map<String, Value>, String)> {
    let inner = snapshot.get("snapshot")?;
    let nodes = inner.get("nodes")?.as_object()?;
    let root_id = inner.get("rootId")?.as_str()?.to_string();
    Some((nodes, root_id))
}

fn node_str<'a>(node: &'a Value, key: &str) -> Option<&'a str> {
    node.get("props")?.get(key)?.as_str()
}

/// The `MenuBarExtra` node itself — the root's first child.
fn menu_bar_node<'a>(nodes: &'a serde_json::Map<String, Value>, root_id: &str) -> Option<&'a Value> {
    let root = nodes.get(root_id)?;
    let first = root.get("children")?.as_array()?.first()?.as_str()?;
    nodes.get(first)
}

fn children_of<'a>(nodes: &'a serde_json::Map<String, Value>, node: &Value) -> Vec<&'a Value> {
    node.get("children")
        .and_then(Value::as_array)
        .map(|ids| ids.iter().filter_map(|id| nodes.get(id.as_str()?)).collect())
        .unwrap_or_default()
}

/// A menu item's id carries the callback to invoke, so a click needs no
/// separate lookup table that could fall out of sync with the tree.
fn callback_id(node: &Value) -> Option<String> {
    Some(node.get("props")?.get("onAction")?.get("__callback")?.as_str()?.to_string())
}

fn build_items<R: Runtime>(
    app: &AppHandle<R>,
    nodes: &serde_json::Map<String, Value>,
    parent: &Value,
    out: &mut Vec<Box<dyn tauri::menu::IsMenuItem<R>>>,
) -> Result<(), tauri::Error> {
    for child in children_of(nodes, parent) {
        match child.get("type").and_then(Value::as_str) {
            Some("MenuBarExtra.Item") => {
                let title = node_str(child, "title").unwrap_or("Untitled");
                // No callback means nothing to run; still shown, disabled,
                // so the menu matches what the extension declared.
                let id = callback_id(child).unwrap_or_default();
                let enabled = !id.is_empty();
                out.push(Box::new(MenuItem::with_id(app, id, title, enabled, None::<&str>)?));
            }
            Some("MenuBarExtra.Section") => {
                // Raycast draws a separator above a titled section; a
                // section title isn't a clickable item in a tray menu.
                if !out.is_empty() {
                    out.push(Box::new(PredefinedMenuItem::separator(app)?));
                }
                if let Some(title) = node_str(child, "title") {
                    out.push(Box::new(MenuItem::with_id(app, format!("section:{title}"), title, false, None::<&str>)?));
                }
                build_items(app, nodes, child, out)?;
            }
            Some("MenuBarExtra.Submenu") => {
                let title = node_str(child, "title").unwrap_or("Submenu");
                let mut nested: Vec<Box<dyn tauri::menu::IsMenuItem<R>>> = Vec::new();
                build_items(app, nodes, child, &mut nested)?;
                let refs: Vec<&dyn tauri::menu::IsMenuItem<R>> = nested.iter().map(|i| i.as_ref()).collect();
                out.push(Box::new(Submenu::with_items(app, title, true, &refs)?));
            }
            _ => {}
        }
    }
    Ok(())
}

fn rebuild(app: &AppHandle, extension_id: &str) {
    let Some(state) = app.try_state::<MenuBarState>() else { return };
    let snapshot = {
        let entries = state.entries.lock().unwrap();
        match entries.get(extension_id) {
            Some(entry) => entry.snapshot.clone(),
            None => return,
        }
    };

    let Some((nodes, root_id)) = nodes_of(&snapshot) else { return };
    let Some(bar) = menu_bar_node(nodes, &root_id) else { return };

    let mut items: Vec<Box<dyn tauri::menu::IsMenuItem<tauri::Wry>>> = Vec::new();
    if let Err(e) = build_items(app, nodes, bar, &mut items) {
        log::warn!("menu-bar: could not build items for '{extension_id}': {e}");
        return;
    }
    let refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = items.iter().map(|i| i.as_ref()).collect();
    let menu = match Menu::with_items(app, &refs) {
        Ok(menu) => menu,
        Err(e) => {
            log::warn!("menu-bar: could not build menu for '{extension_id}': {e}");
            return;
        }
    };

    let title = node_str(bar, "title").map(str::to_string);
    let tooltip = node_str(bar, "tooltip").map(str::to_string).or_else(|| title.clone());
    let icon = tray_image(app, extension_id, bar);

    let mut entries = state.entries.lock().unwrap();
    let Some(entry) = entries.get_mut(extension_id) else { return };

    if let Some(existing) = entry.icon.as_ref() {
        let _ = existing.set_menu(Some(menu));
        let _ = existing.set_title(title.as_deref());
        let _ = existing.set_tooltip(tooltip.as_deref());
        return;
    }

    let owner = extension_id.to_string();
    let mut builder = TrayIconBuilder::with_id(tray_id(extension_id))
        .menu(&menu)
        .on_menu_event(move |app, event| {
            let id = event.id.as_ref().to_string();
            // Section headings are disabled and carry no callback.
            if id.is_empty() || id.starts_with("section:") {
                return;
            }
            let app = app.clone();
            let owner = owner.clone();
            tauri::async_runtime::spawn(async move {
                if let Some(state) = app.try_state::<crate::application::state::AppState>() {
                    if let Err(e) = state
                        .extension_host
                        .notify(
                            "extension.invokeCallback",
                            Some(serde_json::json!({ "callbackId": id, "args": [{ "type": "left-click" }] })),
                        )
                        .await
                    {
                        log::warn!("menu-bar: callback for '{owner}' failed: {e}");
                    }
                }
            });
        });
    if let Some(image) = icon {
        builder = builder.icon(image);
    }
    if let Some(title) = title.as_deref() {
        builder = builder.title(title);
    }
    if let Some(tooltip) = tooltip.as_deref() {
        builder = builder.tooltip(tooltip);
    }

    match builder.build(app) {
        Ok(icon) => entry.icon = Some(icon),
        Err(e) => log::warn!("menu-bar: could not create a tray icon for '{extension_id}': {e}"),
    }
}

/// The icon image for an extension's tray entry.
///
/// Three steps, most specific first:
///
/// 1. `MenuBarExtra`'s own `icon` prop, when it names a file. An extension
///    may equally pass an emoji (`icon="📚"`) or an `Icon.*` name, neither
///    of which is an image — those fall through.
/// 2. The extension's **manifest icon**, which the registry has already
///    resolved to an absolute path. This is what stops every menu-bar
///    extension from wearing OpenRay's own icon, which makes two of them
///    indistinguishable in the tray.
/// 3. OpenRay's icon, so there is always *something* to click.
fn tray_image(app: &AppHandle, extension_id: &str, bar: &Value) -> Option<Image<'static>> {
    if let Some(image) = node_str(bar, "icon").and_then(load_image) {
        return Some(image);
    }
    if let Some(state) = app.try_state::<crate::application::state::AppState>() {
        if let Some(icon) = state
            .extensions
            .list()
            .into_iter()
            .find(|e| e.id == extension_id)
            .and_then(|e| e.icon)
        {
            if let Some(image) = load_image(&icon) {
                return Some(image);
            }
        }
    }
    // `default_window_icon` borrows from the app, so it has to be taken
    // into owned data to satisfy the `'static` return.
    app.default_window_icon()
        .map(|icon| Image::new_owned(icon.rgba().to_vec(), icon.width(), icon.height()))
}

/// An absolute path to a decodable image, or nothing. Anything else an
/// icon field can hold — an emoji, an `Icon.*` name — lands here and is
/// correctly rejected.
fn load_image(path: &str) -> Option<Image<'static>> {
    if !std::path::Path::new(path).is_absolute() {
        return None;
    }
    // Decoded with the `image` crate rather than `Image::from_path`, which
    // needs a Tauri image-format feature this build doesn't enable.
    let decoded = image::open(path).ok()?;
    let rgba = decoded.to_rgba8();
    let (width, height) = rgba.dimensions();
    Some(Image::new_owned(rgba.into_raw(), width, height))
}
