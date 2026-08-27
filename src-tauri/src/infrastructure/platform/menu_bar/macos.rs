//! macOS menu bar reading/activation via the Accessibility API.
//!
//! No focus tracking needed here (unlike Linux/Windows): the palette is a
//! non-activating `NSPanel` (see `macos_panel`), so it never steals
//! frontmost-application status — the target is simply whatever
//! `NSWorkspace` already reports as frontmost when this runs.
//!
//! Unverified on real hardware — see the plan's Open Questions. Written
//! directly against the documented AX attribute names (`AXMenuBar`,
//! `AXMenuBarItem`, `AXTitle`, `AXChildren`, `AXEnabled`,
//! `AXMenuItemCmdChar`) rather than guessed.

use objc2_app_kit::NSWorkspace;

use super::{MenuBarRead, RawMenuNode};
use crate::infrastructure::platform::macos_accessibility::{self, AXElement};

pub fn available() -> bool {
    macos_accessibility::is_trusted()
}

pub fn read() -> MenuBarRead {
    read_inner().unwrap_or_default()
}

fn read_inner() -> Option<MenuBarRead> {
    if !macos_accessibility::ensure_trusted_with_prompt() {
        return None;
    }

    let workspace = NSWorkspace::sharedWorkspace();
    let frontmost = workspace.frontmostApplication()?;
    let pid = frontmost.processIdentifier();
    let app_name = frontmost.localizedName().map(|s| s.to_string());

    let ax_app = AXElement::for_application(pid)?;
    let Some(menu_bar) = ax_app.attribute_element("AXMenuBar") else {
        return Some(MenuBarRead { app_name, nodes: Vec::new() });
    };

    let mut nodes = Vec::new();
    for (index, item) in menu_bar_items(&menu_bar).into_iter().enumerate() {
        // Index 0 is conventionally the Apple menu — not app-specific,
        // not useful to search from within OpenRay.
        if index == 0 {
            continue;
        }
        if let Some(node) = build_node(&item, &[index]) {
            nodes.push(node);
        }
    }

    Some(MenuBarRead { app_name, nodes })
}

/// `AXMenuBarItem` is the documented, role-filtered way to get a menu
/// bar's top-level items; falling back to plain `AXChildren` covers any
/// AX implementation that doesn't support the more specific attribute.
fn menu_bar_items(menu_bar: &AXElement) -> Vec<AXElement> {
    let items = menu_bar.attribute_elements("AXMenuBarItem");
    if items.is_empty() {
        menu_bar.attribute_elements("AXChildren")
    } else {
        items
    }
}

/// A menu bar item / submenu-bearing item has exactly one AX child: the
/// `AXMenu` that pops up, whose own children are the real entries.
fn popup_entries(item: &AXElement) -> Vec<AXElement> {
    item.attribute_elements("AXChildren").first().map(|menu| menu.attribute_elements("AXChildren")).unwrap_or_default()
}

fn build_node(item: &AXElement, path: &[usize]) -> Option<RawMenuNode> {
    let title = item.attribute_string("AXTitle").unwrap_or_default();
    if title.is_empty() {
        // Covers both unlabeled separators and anything else AX can't
        // give a title for — nothing useful to show or search either way.
        return None;
    }
    let enabled = item.attribute_bool("AXEnabled").unwrap_or(true);
    let entries = popup_entries(item);

    if !entries.is_empty() {
        let children = entries
            .iter()
            .enumerate()
            .filter_map(|(index, child)| {
                let mut child_path = path.to_vec();
                child_path.push(index);
                build_node(child, &child_path)
            })
            .collect();
        return Some(RawMenuNode::Submenu { title, enabled, children });
    }

    // Modifier keys (`AXMenuItemCmdModifiers`) aren't decoded — the exact
    // bitmask values aren't something this pass could verify against real
    // hardware, so the shortcut only shows the Command-key char, which
    // covers the overwhelming majority of real shortcuts.
    let shortcut = item.attribute_string("AXMenuItemCmdChar").filter(|s| !s.is_empty()).map(|c| format!("⌘{c}"));
    let token = format!("ax:{}", path.iter().map(usize::to_string).collect::<Vec<_>>().join("."));

    Some(RawMenuNode::Item { title, enabled, shortcut, token })
}

pub fn activate(token: &str) -> bool {
    activate_inner(token).is_some()
}

fn activate_inner(token: &str) -> Option<()> {
    let path_str = token.strip_prefix("ax:")?;
    let path: Vec<usize> = path_str.split('.').map(str::parse).collect::<Result<_, _>>().ok()?;

    let workspace = NSWorkspace::sharedWorkspace();
    let pid = workspace.frontmostApplication()?.processIdentifier();
    let ax_app = AXElement::for_application(pid)?;
    let menu_bar = ax_app.attribute_element("AXMenuBar")?;

    let mut siblings = menu_bar_items(&menu_bar);
    let mut target = None;
    for (depth, &index) in path.iter().enumerate() {
        let item = siblings.into_iter().nth(index)?;
        if depth + 1 == path.len() {
            target = Some(item);
            break;
        }
        siblings = popup_entries(&item);
    }

    target?.perform_action("AXPress");
    Some(())
}
