//! macOS window enumeration/activation/close via the Accessibility API.
//!
//! Deliberately not `CGWindowList`: reading *other* apps' window titles
//! there needs the separate Screen Recording permission on top of
//! Accessibility, and AX is the API the menu-bar backend needs anyway —
//! one permission, one API, for both Navigation features.
//!
//! Unverified on real hardware — this dev machine is Linux — see the
//! plan's Open Questions. Written directly against the documented,
//! stable `objc2-app-kit`/`AXUIElement` APIs rather than guessed.

use objc2_app_kit::{NSApplicationActivationOptions, NSApplicationActivationPolicy, NSRunningApplication, NSWorkspace};

use super::NativeWindow;
use crate::infrastructure::platform::macos_accessibility::{self, AXElement};

pub fn available() -> bool {
    macos_accessibility::is_trusted()
}

pub fn list() -> Vec<NativeWindow> {
    // The one action-triggering call in this module — prompts once if
    // not yet trusted, matching how paste injection already handles this
    // (see `ensure_trusted_with_prompt`'s doc comment). `available()`
    // above stays a cheap, non-prompting check so search's per-keystroke
    // `commands()` call never triggers the dialog itself.
    if !macos_accessibility::ensure_trusted_with_prompt() {
        return Vec::new();
    }

    let workspace = NSWorkspace::sharedWorkspace();
    let running = workspace.runningApplications();
    let frontmost_pid = workspace.frontmostApplication().map(|app| app.processIdentifier());

    // No direct "recently used" ordering API for running apps; pulling
    // the frontmost app to the front is the closest MRU proxy available
    // without our own focus-history tracking (same tradeoff the Linux
    // and Windows backends make from their own native ordering).
    let mut apps: Vec<_> = running.to_vec();
    apps.sort_by_key(|app| if Some(app.processIdentifier()) == frontmost_pid { 0 } else { 1 });

    let mut out = Vec::new();
    for app in &apps {
        if app.activationPolicy() != NSApplicationActivationPolicy::Regular {
            continue;
        }

        let pid = app.processIdentifier();
        let app_name = app.localizedName().map(|s| s.to_string()).unwrap_or_default();

        let Some(ax_app) = AXElement::for_application(pid) else { continue };
        for (index, window) in ax_app.attribute_elements("AXWindows").into_iter().enumerate() {
            let Some(title) = window.attribute_string("AXTitle") else { continue };
            if title.is_empty() {
                continue;
            }
            out.push(NativeWindow {
                id: format!("{pid}:{index}"),
                title,
                app_name: app_name.clone(),
                // Reuses the exact app-name-equality path
                // `application::navigation::match_app_icon` already uses
                // for Linux — `MacosAppScanner`'s installed-app names come
                // from the same `CFBundleDisplayName`/`CFBundleName`
                // source, so no macOS-specific icon extraction is needed
                // here; a window this can't match just falls back to the
                // frontend's initial-letter avatar.
                app_match_hint: app_name.to_lowercase(),
                icon: None,
            });
        }
    }

    out
}

/// Splits a `"{pid}:{index}"` window id. `index` is only valid against an
/// `AXWindows` snapshot taken at roughly the same time — see the module
/// doc and the plan's Open Questions on staleness.
fn parse_id(id: &str) -> Option<(i32, usize)> {
    let (pid, index) = id.split_once(':')?;
    Some((pid.parse().ok()?, index.parse().ok()?))
}

fn resolve_window(id: &str) -> Option<AXElement> {
    let (pid, index) = parse_id(id)?;
    let ax_app = AXElement::for_application(pid)?;
    ax_app.attribute_elements("AXWindows").into_iter().nth(index)
}

pub fn activate(id: &str) -> bool {
    let Some((pid, _)) = parse_id(id) else { return false };
    let Some(window) = resolve_window(id) else { return false };

    let raised = window.perform_action("AXRaise");
    let activated = NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
        .map(|app| app.activateWithOptions(NSApplicationActivationOptions::ActivateIgnoringOtherApps))
        .unwrap_or(false);

    raised || activated
}

pub fn close(id: &str) -> bool {
    let Some(window) = resolve_window(id) else { return false };
    let Some(close_button) = window.attribute_element("AXCloseButton") else { return false };
    close_button.perform_action("AXPress")
}
