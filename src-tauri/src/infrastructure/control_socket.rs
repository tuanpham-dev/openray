//! A local control socket, so extension development can be driven from a
//! terminal instead of the Settings window.
//!
//! The loop this exists for is the one every extension author already has
//! muscle memory for: `npm run dev` in the extension's folder, commands
//! appear in the launcher, saves hot-reload, and build errors and
//! `console.log` land in the terminal you're already looking at. All of
//! that machinery already exists (`application::dev_extensions` and the
//! host's own watcher); the only thing missing was a way for a separate
//! process to reach it.
//!
//! Deliberately thin: the CLI never builds anything itself, it asks the
//! running app to. One build pipeline for dev mode, installs, and packing
//! is what keeps a dev build and a shipped build the same artifact, and a
//! CLI that compiled its own way would be the first thing to break that.
//!
//! **Unix only for now.** Windows needs a named pipe rather than a socket
//! file; nothing else in the plan depends on it, and the audience for a
//! development CLI skews heavily Unix. The app runs fine without it.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tokio::sync::broadcast;

use crate::application::state::AppState;

/// Capacity of the event fan-out. A CLI client that stalls long enough to
/// fall this far behind loses the oldest lines rather than blocking the
/// app — dropped log lines are an acceptable failure, a wedged extension
/// host is not.
const EVENT_BUFFER: usize = 256;

/// One line of output for an attached CLI client.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlEvent {
    /// The extension this concerns, so a client attached to one folder
    /// doesn't see another's output.
    pub extension_id: String,
    /// `"build"` or `"log"`.
    pub kind: String,
    pub payload: Value,
}

/// Broadcasts dev-mode activity to whatever CLI clients are attached.
/// Managed separately from `AppState` so `dispatch_notification` can reach
/// it without the control socket becoming a dependency of the bridge.
pub struct ControlEvents {
    sender: broadcast::Sender<ControlEvent>,
}

impl ControlEvents {
    pub fn new() -> Self {
        let (sender, _) = broadcast::channel(EVENT_BUFFER);
        Self { sender }
    }

    /// Publishes an event. Failing to send means nobody is attached, which
    /// is the normal case and not worth reporting.
    pub fn publish(&self, event: ControlEvent) {
        let _ = self.sender.send(event);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<ControlEvent> {
        self.sender.subscribe()
    }
}

impl Default for ControlEvents {
    fn default() -> Self {
        Self::new()
    }
}

/// Where the socket lives: the app data dir, which is where runtime state
/// belongs (the database and installed extensions are already there).
pub fn socket_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("control.sock"))
}

/// Records the socket's location in the config directory, which is the one
/// path an outside process can compute without knowing anything about
/// Tauri.
///
/// The app data directory is derived from the bundle identifier
/// (`~/.local/share/com.openray.desktop`, and something different on each
/// platform); a CLI reimplementing that rule in JavaScript would be a
/// second source of truth that silently breaks the day the identifier or
/// Tauri's resolution changes. A pointer file means the app tells the CLI
/// where to look, and `paths::config_dir` is already the documented,
/// stable, cross-platform location for exactly this kind of thing.
fn write_socket_pointer(app: &AppHandle, path: &std::path::Path) {
    match crate::infrastructure::paths::config_dir(app) {
        Ok(dir) => {
            if let Err(e) = std::fs::write(dir.join("control-socket"), path.to_string_lossy().as_bytes()) {
                log::warn!("control socket: could not record its path for the CLI: {e}");
            }
        }
        Err(e) => log::warn!("control socket: could not resolve the config dir: {e}"),
    }
}

#[derive(Debug, Deserialize)]
struct ControlRequest {
    id: Option<u64>,
    method: String,
    #[serde(default)]
    params: Value,
}

#[cfg(unix)]
pub fn spawn(app: &AppHandle) {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::{UnixListener, UnixStream};

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let path = match socket_path(&app) {
            Ok(path) => path,
            Err(e) => {
                log::warn!("control socket: could not resolve a path: {e}");
                return;
            }
        };

        // A socket file left behind by a crashed run would make binding
        // fail forever; nothing else owns this path, so removing it is safe.
        let _ = std::fs::remove_file(&path);
        let listener = match UnixListener::bind(&path) {
            Ok(listener) => listener,
            Err(e) => {
                log::warn!("control socket: could not bind {}: {e}", path.display());
                return;
            }
        };

        // 0600: this socket starts builds and mounts code as the user, so
        // it must not be reachable by other accounts on a shared machine.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Err(e) = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)) {
                log::warn!("control socket: could not restrict permissions on {}: {e}", path.display());
            }
        }
        write_socket_pointer(&app, &path);
        log::info!("control socket listening at {}", path.display());

        loop {
            let (stream, _) = match listener.accept().await {
                Ok(accepted) => accepted,
                Err(e) => {
                    log::warn!("control socket: accept failed: {e}");
                    continue;
                }
            };
            let app = app.clone();
            tauri::async_runtime::spawn(async move { serve_client(app, stream).await });
        }
    });

    async fn serve_client(app: AppHandle, stream: UnixStream) {
        let (reader, mut writer) = stream.into_split();
        let mut lines = BufReader::new(reader).lines();

        // Every client gets the event stream from the moment it connects;
        // it names the extension it cares about by calling `develop.start`,
        // and until then sees nothing.
        let mut events = match app.try_state::<ControlEvents>() {
            Some(events) => events.subscribe(),
            None => return,
        };
        let (writes, mut outbox) = tokio::sync::mpsc::channel::<String>(EVENT_BUFFER);

        // One task owns the write half, so responses and streamed events
        // can't interleave mid-line.
        let writer_task = tauri::async_runtime::spawn(async move {
            while let Some(line) = outbox.recv().await {
                if writer.write_all(line.as_bytes()).await.is_err() {
                    break;
                }
                if writer.write_all(b"\n").await.is_err() {
                    break;
                }
            }
        });

        let attached: std::sync::Arc<std::sync::Mutex<Option<String>>> = Default::default();
        let event_writes = writes.clone();
        let event_filter = attached.clone();
        let event_task = tauri::async_runtime::spawn(async move {
            loop {
                match events.recv().await {
                    Ok(event) => {
                        let wanted = event_filter.lock().unwrap().as_deref() == Some(event.extension_id.as_str());
                        if !wanted {
                            continue;
                        }
                        let line = serde_json::to_string(&json!({ "event": event.kind, "extensionId": event.extension_id, "payload": event.payload }))
                            .unwrap_or_default();
                        if event_writes.send(line).await.is_err() {
                            break;
                        }
                    }
                    // Lagged: the client fell behind. Keep going with what's
                    // current rather than tearing the session down.
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });

        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            let request: ControlRequest = match serde_json::from_str(&line) {
                Ok(request) => request,
                Err(e) => {
                    let _ = writes.send(json!({ "error": format!("malformed request: {e}") }).to_string()).await;
                    continue;
                }
            };

            let result = handle(&app, &request, &attached).await;
            let response = match result {
                Ok(value) => json!({ "id": request.id, "result": value }),
                Err(message) => json!({ "id": request.id, "error": message }),
            };
            if writes.send(response.to_string()).await.is_err() {
                break;
            }
        }

        // The client hung up. Stop watching whatever it was developing —
        // an abandoned watcher rebuilding files nobody is looking at is
        // exactly the leak `developStop` exists to prevent.
        let developing = attached.lock().unwrap().clone();
        if let Some(id) = developing {
            if let Some(state) = app.try_state::<AppState>() {
                crate::application::dev_extensions::stop(&state, &id).await;
            }
        }
        event_task.abort();
        drop(writes);
        let _ = writer_task.await;
    }

    async fn handle(
        app: &AppHandle,
        request: &ControlRequest,
        attached: &std::sync::Arc<std::sync::Mutex<Option<String>>>,
    ) -> Result<Value, String> {
        match request.method.as_str() {
            "ping" => Ok(json!({ "pong": true })),
            "develop.start" => {
                let path = request.params.get("path").and_then(Value::as_str).ok_or("develop.start needs a path")?;
                let state = app.try_state::<AppState>().ok_or("app state not managed")?;
                let entry = crate::api::extensions::develop_extension_at(app, &state, path).await?;
                *attached.lock().unwrap() = Some(entry.id.clone());
                Ok(json!({ "id": entry.id, "title": entry.title, "path": entry.path }))
            }
            "develop.stop" => {
                let id = match request.params.get("id").and_then(Value::as_str) {
                    Some(id) => id.to_string(),
                    None => attached.lock().unwrap().clone().ok_or("develop.stop needs an id")?,
                };
                let state = app.try_state::<AppState>().ok_or("app state not managed")?;
                crate::application::dev_extensions::stop(&state, &id).await;
                *attached.lock().unwrap() = None;
                Ok(json!({ "stopped": id }))
            }
            // Unregisters entirely, without touching a single file in the
            // author's folder. A CLI that can start something it cannot
            // undo is half a tool: this is what lets a scripted session
            // clean up after itself instead of leaving a registration
            // behind for someone to find in Settings later.
            "develop.remove" => {
                let id = match request.params.get("id").and_then(Value::as_str) {
                    Some(id) => id.to_string(),
                    None => attached.lock().unwrap().clone().ok_or("develop.remove needs an id")?,
                };
                let state = app.try_state::<AppState>().ok_or("app state not managed")?;
                crate::application::dev_extensions::stop(&state, &id).await;
                // Same reason as `remove_dev_extension`: a menu-bar
                // command's tray icon has no view teardown to ride on.
                crate::application::menu_bar::remove(app, &id);
                state.extensions.unregister(&id).map_err(|e| e.to_string())?;
                state.command_settings.delete_for_extension(&id).map_err(|e| e.to_string())?;
                state.root_commands.clear_extension(&id);
                state.sync_hotkey_bindings(app);
                *attached.lock().unwrap() = None;
                Ok(json!({ "removed": id }))
            }
            "command.list" => {
                let state = app.try_state::<AppState>().ok_or("app state not managed")?;
                Ok(json!({ "commands": crate::application::extension_commands::listable_commands(&state) }))
            }
            // The CLI's `openray run <id>` — a no-view id runs headlessly;
            // a view/menu-bar id opens the app instead, see
            // `extension_commands::run_headless`'s doc comment.
            "command.run" => {
                let id = request.params.get("id").and_then(Value::as_str).ok_or("command.run needs an id")?;
                let arguments: std::collections::HashMap<String, String> =
                    request.params.get("arguments").map(|value| serde_json::from_value(value.clone()).unwrap_or_default()).unwrap_or_default();
                let state = app.try_state::<AppState>().ok_or("app state not managed")?;
                crate::application::extension_commands::run_headless(app, &state, id, &arguments).await?;
                Ok(json!({ "id": id }))
            }
            other => Err(format!("unknown method: {other}")),
        }
    }
}

/// Windows has no Unix domain sockets; a named-pipe implementation is
/// follow-up work. Everything else about dev mode works there — only the
/// terminal-driven entry point is missing.
#[cfg(not(unix))]
pub fn spawn(_app: &AppHandle) {
    log::info!("control socket: not supported on this platform yet");
}
