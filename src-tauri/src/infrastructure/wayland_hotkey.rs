//! Global hotkey registration via the XDG desktop portal's GlobalShortcuts
//! interface, for Wayland sessions where `tauri-plugin-global-shortcut`'s
//! X11-style key-grab can't work (Wayland gives no client the ability to
//! grab an arbitrary global key combo directly — only the compositor,
//! mediated through this portal, can).
//!
//! The portal's `BindShortcuts` call triggers the compositor's own
//! "allow OpenRay to bind these shortcuts?" dialog on first use (and whenever
//! the trigger set changes, since rebinding tears the whole session down
//! and creates a fresh one — see `spawn_registration_multi`); the user can
//! decline or the portal itself may be absent on some compositors, so
//! callers must treat failure here as "no automatic hotkey available", not
//! a hard error — see `hotkey::sync_bindings`'s fallback to the
//! single-instance toggle.

use std::sync::atomic::{AtomicU64, Ordering};

use ashpd::desktop::global_shortcuts::{BindShortcutsOptions, GlobalShortcuts, NewShortcut};
use ashpd::desktop::CreateSessionOptions;
use futures_util::StreamExt;
use tauri::{AppHandle, Emitter};

use crate::error::Error;
use crate::infrastructure::hotkey::HOTKEY_UNAVAILABLE_EVENT;
use crate::infrastructure::window;

const TOGGLE_SHORTCUT_ID: &str = "toggle-palette";
const COMMAND_SHORTCUT_PREFIX: &str = "cmd:";

/// A shortcut to bind through the portal, independent of what it's for —
/// the palette toggle or a specific command (see `hotkey::sync_bindings`,
/// which builds these from `HotkeyAction`).
pub struct PortalShortcut {
    pub id: String,
    pub trigger: String,
    pub description: String,
}

/// Monotonic counter guarding against overlapping portal sessions: every
/// call to `spawn_registration_multi` bumps it and captures the new value,
/// so a previous activation loop — still alive because the portal session
/// it holds is only dropped when that loop exits — notices on its next
/// event that a newer registration has superseded it and stops, rather
/// than continuing to (redundantly, and incorrectly once shortcuts have
/// changed) act on stale bindings.
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// Pure predicate, decoupled from the static counter so it's testable
/// without races against other tests touching `GENERATION` concurrently.
fn is_stale(current_generation: u64, captured_generation: u64) -> bool {
    current_generation != captured_generation
}

/// Attempts to bind every shortcut in `shortcuts` through the portal in a
/// single session and, on success, spawns a task that dispatches
/// activations for the lifetime of that session (or until a newer
/// registration supersedes it). Returns `Err` if the portal is
/// unavailable, the bind request fails, or the user declines — the caller
/// decides what to do about that (currently: emit `HOTKEY_UNAVAILABLE_EVENT`
/// and leave the affected shortcuts unbound rather than pretending they're
/// active).
async fn try_register(app: AppHandle, shortcuts: Vec<PortalShortcut>, generation: u64) -> Result<(), Error> {
    let portal = GlobalShortcuts::new().await.map_err(|e| Error::msg(e.to_string()))?;

    let session = portal.create_session(CreateSessionOptions::default()).await.map_err(|e| Error::msg(e.to_string()))?;

    let new_shortcuts: Vec<NewShortcut> = shortcuts
        .iter()
        .map(|s| NewShortcut::new(s.id.clone(), s.description.clone()).preferred_trigger(Some(s.trigger.as_str())))
        .collect();

    let request = portal
        .bind_shortcuts(&session, &new_shortcuts, None, BindShortcutsOptions::default())
        .await
        .map_err(|e| Error::msg(e.to_string()))?;
    request.response().map_err(|e| Error::msg(e.to_string()))?;

    let mut activated = portal.receive_activated().await.map_err(|e| Error::msg(e.to_string()))?;

    tauri::async_runtime::spawn(async move {
        // Keep `portal` and `session` alive for as long as this loop runs —
        // dropping either would close the D-Bus session and stop delivery.
        let _session = session;
        let _portal = portal;
        while let Some(event) = activated.next().await {
            if is_stale(GENERATION.load(Ordering::SeqCst), generation) {
                break;
            }

            let shortcut_id = event.shortcut_id();
            if shortcut_id == TOGGLE_SHORTCUT_ID {
                let _ = window::toggle_palette(&app);
            } else if let Some(command_id) = shortcut_id.strip_prefix(COMMAND_SHORTCUT_PREFIX) {
                crate::application::hotkey_dispatch::run(&app, command_id);
            }
        }
    });

    Ok(())
}

/// Tries the portal in the background with every desired shortcut; on
/// failure, emits `HOTKEY_UNAVAILABLE_EVENT` so the frontend can surface
/// the fallback banner. Fire-and-forget by design — `hotkey::sync_bindings`
/// (a sync fn, possibly called from Tauri's setup closure) can't await
/// this.
pub fn spawn_registration_multi(app: AppHandle, shortcuts: Vec<PortalShortcut>) {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn(async move {
        if let Err(e) = try_register(app.clone(), shortcuts, generation).await {
            log::warn!("Wayland GlobalShortcuts portal unavailable ({e}); no automatic hotkeys");
            // `Error` isn't `Serialize` (its `#[from]` variants wrap
            // external crate error types that aren't either) — the event
            // payload only ever needed the message text anyway.
            let _ = app.emit(HOTKEY_UNAVAILABLE_EVENT, e.to_string());
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_generation_is_not_stale_against_itself() {
        assert!(!is_stale(3, 3));
    }

    #[test]
    fn an_older_generation_is_stale_once_superseded() {
        assert!(is_stale(4, 3));
    }
}
