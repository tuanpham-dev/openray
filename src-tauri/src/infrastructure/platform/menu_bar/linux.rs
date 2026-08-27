//! Reads/activates the previously-focused window's menu bar over D-Bus.
//!
//! Three discovery paths, tried in order — see `discover`:
//! 1. Qt/KDE: `_KDE_NET_WM_APPMENU_*` window properties name a
//!    `com.canonical.dbusmenu` object directly (no registrar needed).
//! 2. GTK: `_GTK_*` window properties name an `org.gtk.Menus`/
//!    `org.gtk.Actions` export.
//! 3. `com.canonical.AppMenu.Registrar.GetMenuForWindow` — a running
//!    registrar's answer is itself a `dbusmenu` address, so it reuses the
//!    KDE reader.
//!
//! Best-effort throughout: no registrar running and no GTK app on the
//! session actually exporting `_GTK_MENUBAR_OBJECT_PATH` are both the
//! common case on a stock XFCE desktop (verified empty on this dev
//! machine), so every step degrades to "found nothing" rather than an
//! error. The GTK reader in particular is implemented from the
//! `org.gtk.Menus`/`org.gtk.Actions` protocol as documented, but — unlike
//! the KDE path — has no live exporter available in this environment to
//! verify end-to-end; treat it as the least-tested part of Navigation.

use std::collections::{HashMap, HashSet};

use x11rb::connection::Connection;
use x11rb::protocol::xproto::{AtomEnum, ConnectionExt};
use zbus::blocking::Connection as DbusConnection;
use zbus::zvariant::{self, OwnedValue, Value};

use super::{MenuBarRead, RawMenuNode};
use crate::infrastructure::platform::linux_focus;

/// Separates token segments. Bus unique names look like `:1.32` — a plain
/// `:` join would make service/path ambiguous to split back apart, so
/// tokens use a byte that can never appear in a bus name or object path.
const SEP: char = '\u{1f}';

pub fn available() -> bool {
    DbusConnection::session().is_ok()
}

pub fn read() -> MenuBarRead {
    read_inner().unwrap_or_default()
}

fn read_inner() -> Option<MenuBarRead> {
    // The real input focus is very often a hidden 1x1 GTK/Qt focus-proxy
    // *child* window, not the application's actual top-level — verified
    // directly on this machine (Thunar's focus target has no WM_CLASS at
    // all; its parent does). Every property this module reads
    // (WM_CLASS, the KDE/GTK menu-export properties) lives on the
    // top-level, so resolve up to it before doing anything else.
    let xid = linux_focus::resolve_toplevel(linux_focus::previously_focused_window()?);
    let app_name = window_app_name(xid);

    let nodes = match discover(xid) {
        Some(MenuSource::DbusMenu { service, path }) => read_dbusmenu(&service, &path),
        Some(MenuSource::Gtk { bus_name, menubar_path, app_actions_path, win_actions_path }) => {
            read_gtk(&bus_name, &menubar_path, app_actions_path.as_deref(), win_actions_path.as_deref())
        }
        None => Vec::new(),
    };

    Some(MenuBarRead { app_name, nodes })
}

pub fn activate(token: &str) -> bool {
    activate_inner(token).is_some()
}

/// What a token addresses — split out from `activate_inner` purely so the
/// `SEP`-delimited parsing has a pure function to unit-test; the actual
/// D-Bus calls can't run without a live session bus.
#[derive(Debug, PartialEq)]
enum TokenTarget {
    DbusMenu { service: String, path: String, id: i32 },
    GtkAction { bus_name: String, action_path: String, action_name: String },
}

fn parse_token(token: &str) -> Option<TokenTarget> {
    let mut parts = token.split(SEP);
    match parts.next()? {
        "dbusmenu" => {
            let service = parts.next()?.to_string();
            let path = parts.next()?.to_string();
            let id: i32 = parts.next()?.parse().ok()?;
            Some(TokenTarget::DbusMenu { service, path, id })
        }
        "gtk" => {
            let bus_name = parts.next()?.to_string();
            let action_path = parts.next()?.to_string();
            let action_name = parts.next()?.to_string();
            Some(TokenTarget::GtkAction { bus_name, action_path, action_name })
        }
        _ => None,
    }
}

fn activate_inner(token: &str) -> Option<()> {
    match parse_token(token)? {
        TokenTarget::DbusMenu { service, path, id } => {
            let conn = DbusConnection::session().ok()?;
            conn.call_method(
                Some(service.as_str()),
                path.as_str(),
                Some("com.canonical.dbusmenu"),
                "Event",
                &(id, "clicked", Value::from(0i32), 0u32),
            )
            .ok()?;
            Some(())
        }
        TokenTarget::GtkAction { bus_name, action_path, action_name } => {
            let conn = DbusConnection::session().ok()?;
            conn.call_method(
                Some(bus_name.as_str()),
                action_path.as_str(),
                Some("org.gtk.Actions"),
                "Activate",
                &(action_name.as_str(), Vec::<Value>::new(), HashMap::<String, Value>::new()),
            )
            .ok()?;
            Some(())
        }
    }
}

enum MenuSource {
    DbusMenu { service: String, path: String },
    Gtk { bus_name: String, menubar_path: String, app_actions_path: Option<String>, win_actions_path: Option<String> },
}

fn discover(xid: u32) -> Option<MenuSource> {
    let (conn, _) = x11rb::connect(None).ok()?;

    if let (Some(service), Some(path)) =
        (string_prop(&conn, xid, "_KDE_NET_WM_APPMENU_SERVICE_NAME"), string_prop(&conn, xid, "_KDE_NET_WM_APPMENU_OBJECT_PATH"))
    {
        return Some(MenuSource::DbusMenu { service, path });
    }

    if let Some(bus_name) = string_prop(&conn, xid, "_GTK_UNIQUE_BUS_NAME") {
        if let Some(menubar_path) = string_prop(&conn, xid, "_GTK_MENUBAR_OBJECT_PATH") {
            return Some(MenuSource::Gtk {
                bus_name,
                menubar_path,
                app_actions_path: string_prop(&conn, xid, "_GTK_APPLICATION_OBJECT_PATH"),
                win_actions_path: string_prop(&conn, xid, "_GTK_WINDOW_OBJECT_PATH"),
            });
        }
        if let Some(app_menu_path) = string_prop(&conn, xid, "_GTK_APP_MENU_OBJECT_PATH") {
            return Some(MenuSource::Gtk {
                bus_name,
                menubar_path: app_menu_path,
                app_actions_path: string_prop(&conn, xid, "_GTK_APPLICATION_OBJECT_PATH"),
                win_actions_path: string_prop(&conn, xid, "_GTK_WINDOW_OBJECT_PATH"),
            });
        }
    }

    registrar_lookup(xid)
}

fn registrar_lookup(xid: u32) -> Option<MenuSource> {
    let conn = DbusConnection::session().ok()?;
    let reply = conn
        .call_method(
            Some("com.canonical.AppMenu.Registrar"),
            "/com/canonical/AppMenu/Registrar",
            Some("com.canonical.AppMenu.Registrar"),
            "GetMenuForWindow",
            &(xid,),
        )
        .ok()?;
    let (service, path): (String, zvariant::OwnedObjectPath) = reply.body().deserialize().ok()?;
    Some(MenuSource::DbusMenu { service, path: path.to_string() })
}

// ---- Qt/KDE `com.canonical.dbusmenu` ---------------------------------

#[derive(serde::Deserialize, zbus::zvariant::Type)]
struct DbusmenuLayout {
    #[allow(dead_code)]
    id: i32,
    #[allow(dead_code)]
    props: HashMap<String, OwnedValue>,
    children: Vec<OwnedValue>,
}

#[derive(serde::Deserialize, zbus::zvariant::Type)]
struct GetLayoutReply {
    #[allow(dead_code)]
    revision: u32,
    layout: DbusmenuLayout,
}

fn read_dbusmenu(service: &str, path: &str) -> Vec<RawMenuNode> {
    read_dbusmenu_inner(service, path).unwrap_or_default()
}

fn read_dbusmenu_inner(service: &str, path: &str) -> Option<Vec<RawMenuNode>> {
    let conn = DbusConnection::session().ok()?;
    // Best-effort courtesy call some implementations expect before the
    // root's children are populated; failure here isn't fatal.
    let _ = conn.call_method(Some(service), path, Some("com.canonical.dbusmenu"), "AboutToShow", &(0i32,));

    let reply = conn
        .call_method(
            Some(service),
            path,
            Some("com.canonical.dbusmenu"),
            "GetLayout",
            &(0i32, -1i32, Vec::<&str>::new()),
        )
        .ok()?;
    let parsed: GetLayoutReply = reply.body().deserialize().ok()?;

    Some(parsed.layout.children.iter().filter_map(|child| parse_dbusmenu_node(child, service, path)).collect())
}

fn parse_dbusmenu_node(value: &Value, service: &str, path: &str) -> Option<RawMenuNode> {
    let value = unwrap_variant(value);
    let Value::Structure(s) = value else { return None };
    let fields = s.fields();

    let Some(Value::I32(id)) = fields.first() else { return None };
    let Some(Value::Dict(props)) = fields.get(1) else { return None };
    let children_values: &[Value] = match fields.get(2) {
        Some(Value::Array(a)) => a.inner(),
        _ => &[],
    };

    let get_str = |key: &str| dict_str(props, key);
    let get_bool = |key: &str, default: bool| dict_bool(props, key, default);

    if get_str("type").as_deref() == Some("separator") {
        return Some(RawMenuNode::Separator);
    }
    if !get_bool("visible", true) {
        return None;
    }

    let title = get_str("label").unwrap_or_default();
    let enabled = get_bool("enabled", true);
    let children: Vec<RawMenuNode> = children_values.iter().filter_map(|c| parse_dbusmenu_node(c, service, path)).collect();
    let is_submenu = get_str("children-display").as_deref() == Some("submenu") || !children.is_empty();

    if is_submenu {
        Some(RawMenuNode::Submenu { title, enabled, children })
    } else {
        let shortcut = dict_shortcut(props);
        Some(RawMenuNode::Item { title, enabled, shortcut, token: format!("dbusmenu{SEP}{service}{SEP}{path}{SEP}{id}") })
    }
}

fn dict_str(dict: &zvariant::Dict, key: &str) -> Option<String> {
    dict.iter()
        .find(|(k, _)| matches!(unwrap_variant(k), Value::Str(s) if s.as_str() == key))
        .and_then(|(_, v)| match unwrap_variant(v) {
            Value::Str(s) => Some(s.to_string()),
            _ => None,
        })
}

fn dict_bool(dict: &zvariant::Dict, key: &str, default: bool) -> bool {
    dict.iter()
        .find(|(k, _)| matches!(unwrap_variant(k), Value::Str(s) if s.as_str() == key))
        .and_then(|(_, v)| match unwrap_variant(v) {
            Value::Bool(b) => Some(*b),
            _ => None,
        })
        .unwrap_or(default)
}

/// The "shortcut" property is `aas` — a list of key-combos (usually one),
/// each an ordered list of key names. Renders the first combo as
/// `Ctrl+Shift+N`-style text.
fn dict_shortcut(dict: &zvariant::Dict) -> Option<String> {
    let value = dict.iter().find(|(k, _)| matches!(unwrap_variant(k), Value::Str(s) if s.as_str() == "shortcut")).map(|(_, v)| v)?;
    let Value::Array(combos) = unwrap_variant(value) else { return None };
    let first_combo = combos.inner().first()?;
    let Value::Array(keys) = unwrap_variant(first_combo) else { return None };

    let parts: Vec<String> = keys
        .inner()
        .iter()
        .filter_map(|v| match unwrap_variant(v) {
            Value::Str(s) => Some(format_key_name(s.as_str())),
            _ => None,
        })
        .collect();
    (!parts.is_empty()).then(|| parts.join("+"))
}

fn format_key_name(raw: &str) -> String {
    match raw {
        "Control" => "Ctrl".to_string(),
        other => other.to_string(),
    }
}

fn unwrap_variant<'a>(value: &'a Value<'a>) -> &'a Value<'a> {
    match value {
        Value::Value(inner) => unwrap_variant(inner),
        other => other,
    }
}

// ---- GTK `org.gtk.Menus` / `org.gtk.Actions` --------------------------

#[derive(serde::Deserialize, zbus::zvariant::Type)]
struct GtkMenuEntry {
    group: u32,
    menu: u32,
    items: Vec<HashMap<String, OwnedValue>>,
}

fn read_gtk(bus_name: &str, menu_path: &str, app_actions_path: Option<&str>, win_actions_path: Option<&str>) -> Vec<RawMenuNode> {
    read_gtk_inner(bus_name, menu_path, app_actions_path, win_actions_path).unwrap_or_default()
}

fn read_gtk_inner(
    bus_name: &str,
    menu_path: &str,
    app_actions_path: Option<&str>,
    win_actions_path: Option<&str>,
) -> Option<Vec<RawMenuNode>> {
    let conn = DbusConnection::session().ok()?;

    let mut by_group_menu: HashMap<(u32, u32), Vec<HashMap<String, OwnedValue>>> = HashMap::new();
    let mut fetched: HashSet<u32> = HashSet::new();
    let mut pending: Vec<u32> = vec![0];

    // Groups referenced by `:section`/`:submenu` links may live outside
    // the initially requested group and need their own `Start` call —
    // follow them until no new group ids show up.
    while let Some(group) = pending.pop() {
        if !fetched.insert(group) {
            continue;
        }
        let Some(entries) = gtk_start(&conn, bus_name, menu_path, &[group]) else { continue };
        for entry in entries {
            for item in &entry.items {
                for link_key in [":section", ":submenu"] {
                    if let Some((g, _)) = item.get(link_key).and_then(group_menu_pair) {
                        if !fetched.contains(&g) {
                            pending.push(g);
                        }
                    }
                }
            }
            by_group_menu.insert((entry.group, entry.menu), entry.items);
        }
    }

    let root = by_group_menu.get(&(0, 0))?;
    Some(build_gtk_nodes(root, &by_group_menu, bus_name, app_actions_path, win_actions_path))
}

fn gtk_start(conn: &DbusConnection, bus_name: &str, path: &str, groups: &[u32]) -> Option<Vec<GtkMenuEntry>> {
    let reply = conn.call_method(Some(bus_name), path, Some("org.gtk.Menus"), "Start", &(groups,)).ok()?;
    let (entries,): (Vec<GtkMenuEntry>,) = reply.body().deserialize().ok()?;
    Some(entries)
}

fn build_gtk_nodes(
    items: &[HashMap<String, OwnedValue>],
    by_group_menu: &HashMap<(u32, u32), Vec<HashMap<String, OwnedValue>>>,
    bus_name: &str,
    app_actions_path: Option<&str>,
    win_actions_path: Option<&str>,
) -> Vec<RawMenuNode> {
    let mut out = Vec::new();

    for item in items {
        // Sections inline into the parent list (no visual submenu
        // boundary), so recurse without pushing a Submenu node.
        if let Some(link) = item.get(":section").and_then(group_menu_pair) {
            if let Some(section_items) = by_group_menu.get(&link) {
                out.extend(build_gtk_nodes(section_items, by_group_menu, bus_name, app_actions_path, win_actions_path));
            }
            continue;
        }

        let label = item.get("label").and_then(owned_value_str).unwrap_or_default();

        if let Some(link) = item.get(":submenu").and_then(group_menu_pair) {
            let children = by_group_menu
                .get(&link)
                .map(|sub_items| build_gtk_nodes(sub_items, by_group_menu, bus_name, app_actions_path, win_actions_path))
                .unwrap_or_default();
            if !label.is_empty() || !children.is_empty() {
                out.push(RawMenuNode::Submenu { title: label, enabled: true, children });
            }
            continue;
        }

        if label.is_empty() {
            continue;
        }
        let Some(action) = item.get("action").and_then(owned_value_str) else { continue };

        let (action_name, action_path) = if let Some(name) = action.strip_prefix("app.") {
            (name, app_actions_path)
        } else if let Some(name) = action.strip_prefix("win.") {
            (name, win_actions_path)
        } else {
            continue;
        };
        let Some(action_path) = action_path else { continue };

        // GTK actions can report enabled/disabled via `DescribeAll`, but
        // that's a further D-Bus round trip per menu read for a
        // best-effort feature that has no live target to verify against
        // on this platform — items are surfaced as enabled unless GTK
        // itself omits them.
        out.push(RawMenuNode::Item {
            title: label,
            enabled: true,
            shortcut: None,
            token: format!("gtk{SEP}{bus_name}{SEP}{action_path}{SEP}{action_name}"),
        });
    }

    out
}

fn group_menu_pair(value: &OwnedValue) -> Option<(u32, u32)> {
    let Value::Structure(s) = unwrap_variant(value) else { return None };
    let fields = s.fields();
    let Some(Value::U32(g)) = fields.first() else { return None };
    let Some(Value::U32(m)) = fields.get(1) else { return None };
    Some((*g, *m))
}

fn owned_value_str(value: &OwnedValue) -> Option<String> {
    match unwrap_variant(value) {
        Value::Str(s) => Some(s.to_string()),
        _ => None,
    }
}

// ---- shared X11 helpers -------------------------------------------------

fn string_prop(conn: &impl Connection, win: u32, name: &str) -> Option<String> {
    let atom = conn.intern_atom(false, name.as_bytes()).ok()?.reply().ok()?.atom;
    let reply = conn.get_property(false, win, atom, AtomEnum::STRING, 0, 1024).ok()?.reply().ok()?;
    let s = String::from_utf8(reply.value).ok()?;
    (!s.is_empty()).then_some(s)
}

fn window_app_name(win: u32) -> Option<String> {
    let (conn, _) = x11rb::connect(None).ok()?;
    let reply = conn.get_property(false, win, AtomEnum::WM_CLASS, AtomEnum::STRING, 0, 256).ok()?.reply().ok()?;
    let mut parts = reply.value.split(|&b| b == 0).filter(|s| !s.is_empty());
    let instance = parts.next()?;
    let class = parts.next().unwrap_or(instance);
    Some(String::from_utf8_lossy(class).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_dbusmenu_token_with_a_colon_bearing_unique_bus_name() {
        // Unique bus names look like ":1.32" — the whole reason tokens use
        // SEP instead of ':' as a delimiter.
        let token = format!("dbusmenu{SEP}:1.32{SEP}/com/example/menu{SEP}42");
        assert_eq!(
            parse_token(&token),
            Some(TokenTarget::DbusMenu { service: ":1.32".into(), path: "/com/example/menu".into(), id: 42 })
        );
    }

    #[test]
    fn parses_gtk_action_token() {
        let token = format!("gtk{SEP}:1.7{SEP}/org/example/App{SEP}quit");
        assert_eq!(
            parse_token(&token),
            Some(TokenTarget::GtkAction {
                bus_name: ":1.7".into(),
                action_path: "/org/example/App".into(),
                action_name: "quit".into(),
            })
        );
    }

    #[test]
    fn rejects_unknown_prefix_and_truncated_tokens() {
        assert_eq!(parse_token("unknown\u{1f}a\u{1f}b\u{1f}c"), None);
        assert_eq!(parse_token(&format!("dbusmenu{SEP}svc{SEP}path")), None);
        assert_eq!(parse_token(&format!("dbusmenu{SEP}svc{SEP}path{SEP}not-a-number")), None);
    }

    #[test]
    fn formats_control_as_ctrl() {
        assert_eq!(format_key_name("Control"), "Ctrl");
        assert_eq!(format_key_name("Shift"), "Shift");
    }
}

