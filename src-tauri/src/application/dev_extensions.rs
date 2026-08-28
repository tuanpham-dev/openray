//! Dev mode: developing an extension from the folder the author is
//! editing, rather than from a copy under the app's extensions root.
//!
//! The split of responsibilities is deliberate. The Node host owns the
//! *work* — building in place and watching the filesystem (`dev.ts`) —
//! because that's where the build pipeline every other install path uses
//! already lives, and running one pipeline is what keeps a dev build and a
//! shipped build the same artifact. This module owns the *bookkeeping*:
//! which directories the user asked to develop, so a fresh host process
//! (after a crash, or after `call`'s unresponsive-host kill) can have its
//! watchers restored underneath a UI that never stopped saying dev mode was
//! on. Sessions live only in memory: dev mode is something you turn on for
//! a work session, and silently re-watching a folder across an app restart
//! would be a surprise, not a convenience.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Manager, State};

use crate::application::state::AppState;
use crate::infrastructure::extension_host::protocol::HostBuildResult;

/// `extensions.source` value for an extension being developed in place.
/// Distinct from `"installed"` so the palette and Settings can badge it,
/// and so `uninstall_extension` (which deletes `<extensionsRoot>/<id>`) is
/// never the path that removes one — see `remove_dev_extension`.
pub const DEV_SOURCE: &str = "dev";

/// One watched directory, as reported to the Settings pane.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevSession {
    pub id: String,
    pub dir: String,
}

/// In-memory record of what the user asked to develop, for replay after a
/// host respawn. Not the source of truth for *registration* — that's the
/// `extensions` table, which outlives this map.
#[derive(Default)]
pub struct DevExtensions {
    sessions: Mutex<HashMap<String, String>>,
}

impl DevExtensions {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn record(&self, id: &str, dir: &str) {
        self.sessions.lock().unwrap().insert(id.to_string(), dir.to_string());
    }

    pub fn forget(&self, id: &str) -> bool {
        self.sessions.lock().unwrap().remove(id).is_some()
    }

    pub fn list(&self) -> Vec<DevSession> {
        let mut sessions: Vec<DevSession> = self
            .sessions
            .lock()
            .unwrap()
            .iter()
            .map(|(id, dir)| DevSession { id: id.clone(), dir: dir.clone() })
            .collect();
        sessions.sort_by(|a, b| a.id.cmp(&b.id));
        sessions
    }
}

/// Asks the host to build `path` in place and start watching it.
///
/// Rejects a directory whose manifest id collides with an extension that
/// isn't already being developed. Shadowing an installed extension with a
/// dev folder would leave two rows claiming one id — the registry, command
/// settings, hotkeys and `extension_storage` are all keyed by it — with no
/// way to say which one a launch meant. Failing with "uninstall it first"
/// is blunt but unambiguous.
pub async fn start(state: &State<'_, AppState>, path: &str) -> Result<HostBuildResult, String> {
    let value = state
        .extension_host
        .call("extension.developStart", Some(json!({ "path": path })))
        .await
        .map_err(|e| e.to_string())?;
    let result: HostBuildResult = serde_json::from_value(value).map_err(|e| e.to_string())?;

    if let Some(existing) = state.extensions.list().into_iter().find(|e| e.id == result.id) {
        if existing.source != DEV_SOURCE {
            // Undo the watcher the host just started — this call fails, so
            // leaving a watcher behind for an extension we're refusing to
            // register would be a leak with no UI to stop it from.
            stop(state, &result.id).await;
            return Err(format!(
                "'{}' is already installed ({}). Uninstall it before developing a local copy.",
                result.id, existing.source
            ));
        }
    }

    Ok(result)
}

/// Stops watching. Best-effort by design: the caller's own bookkeeping
/// (unregistering, clearing rows) must still happen even when the host is
/// wedged or already gone, which is exactly when a dev session is most
/// likely to be stuck on.
pub async fn stop(state: &State<'_, AppState>, id: &str) {
    state.dev_extensions.forget(id);
    if let Err(e) = state
        .extension_host
        .call("extension.developStop", Some(json!({ "id": id })))
        .await
    {
        log::warn!("failed to stop watching dev extension '{id}': {e}");
    }
}

/// Re-establishes every recorded watcher in a freshly spawned host process
/// — wired to [`ExtensionHost::set_started_handler`] in `lib.rs`.
///
/// Spawns rather than blocking: this runs from inside `ensure_started`'s
/// caller, and each `developStart` below goes back through the very same
/// host, so doing the work inline would re-enter the host's own startup
/// path. A rebuild is a side effect worth having here — the folder may
/// well have changed while the host was down.
///
/// [`ExtensionHost::set_started_handler`]: crate::infrastructure::extension_host::process::ExtensionHost::set_started_handler
pub fn replay(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else { return };
    let sessions = state.dev_extensions.list();
    if sessions.is_empty() {
        return;
    }

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let Some(state) = app.try_state::<AppState>() else { return };
        for session in sessions {
            match state
                .extension_host
                .call("extension.developStart", Some(json!({ "path": session.dir })))
                .await
            {
                Ok(_) => log::info!("dev: resumed watching '{}' at {}", session.id, session.dir),
                Err(e) => {
                    // The folder may be gone, or renamed. Drop the session
                    // rather than retrying forever; the extension stays
                    // registered and runnable from its last build.
                    log::warn!("dev: could not resume watching '{}' at {}: {e}", session.id, session.dir);
                    state.dev_extensions.forget(&session.id);
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_and_forgets_sessions() {
        let dev = DevExtensions::new();
        assert!(dev.list().is_empty());

        dev.record("alpha", "/src/alpha");
        dev.record("beta", "/src/beta");
        let listed = dev.list();
        assert_eq!(listed.len(), 2);
        // Sorted by id, so the Settings pane's order doesn't depend on
        // hash iteration order.
        assert_eq!(listed[0].id, "alpha");
        assert_eq!(listed[0].dir, "/src/alpha");
        assert_eq!(listed[1].id, "beta");

        assert!(dev.forget("alpha"));
        assert!(!dev.forget("alpha"));
        assert_eq!(dev.list().len(), 1);
    }

    #[test]
    fn re_recording_the_same_id_replaces_its_directory() {
        // Developing a second checkout of the same extension: one id, one
        // watcher, the newest directory wins — mirroring `dev.ts`'s own
        // "replace the existing session for this id" behavior.
        let dev = DevExtensions::new();
        dev.record("alpha", "/src/alpha");
        dev.record("alpha", "/src/alpha-fork");
        let listed = dev.list();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].dir, "/src/alpha-fork");
    }
}
