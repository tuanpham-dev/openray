use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use std::sync::Mutex as StdMutex;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tokio::sync::{oneshot, Mutex};

use super::protocol::{encode_frame, FrameDecoder, RpcId, RpcMessage, RpcRequest, RpcResponse};

const CALL_TIMEOUT: Duration = Duration::from_secs(10);

/// How long [`ExtensionHost::call_checked`] waits before it stops assuming
/// the call is simply in flight and starts asking whether the host is
/// still alive.
const HEALTH_CHECK_AFTER: Duration = Duration::from_secs(10);

/// How long the `host.ping` probe itself gets. Short on purpose: the
/// handler (registered in `loader.ts`, and predating this use of it) does
/// no work at all, so a live event loop answers effectively immediately,
/// and anything slower is indistinguishable from wedged.
const PING_TIMEOUT: Duration = Duration::from_secs(2);

/// The ceiling on a call that the health check found to be merely slow.
/// Expiring here fails that one call and leaves the process alone.
const SLOW_CALL_CEILING: Duration = Duration::from_secs(120);

#[derive(Debug, thiserror::Error)]
pub enum HostError {
    #[error("failed to spawn extension host: {0}")]
    Spawn(String),
    #[error("extension host is unresponsive")]
    Unresponsive,
    /// The host was verified alive by `host.ping` but this particular call
    /// still didn't finish in time. Distinct from [`HostError::Unresponsive`]
    /// because the process is deliberately left running — one slow
    /// extension is not a reason to kill every other extension with it.
    #[error("'{method}' did not finish within {seconds}s (the extension host is still running)")]
    CallTooSlow { method: String, seconds: u64 },
    #[error("extension host returned an error: {message} (code {code})")]
    Remote { code: i64, message: String },
    #[error("extension host protocol error: {0}")]
    Protocol(String),
    #[error("host.cjs bundle not found at {0}")]
    MissingBundle(PathBuf),
}

struct RunningProcess {
    child: CommandChild,
}

async fn write_frame_to(process: &Arc<Mutex<Option<RunningProcess>>>, frame: &[u8]) -> Result<(), HostError> {
    let mut guard = process.lock().await;
    let running = guard.as_mut().ok_or_else(|| HostError::Spawn("process not running".into()))?;
    running.child.write(frame).map_err(|e| HostError::Spawn(e.to_string()))
}

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

/// Handles a request Node originated (e.g. `host.clipboard.copy`) and
/// returns the value to send back as the response result, or an error
/// message sent back as a JSON-RPC error.
pub type RequestHandler<R> = Arc<dyn Fn(AppHandle<R>, String, Option<Value>) -> BoxFuture<Result<Value, crate::error::Error>> + Send + Sync>;

/// Handles a notification Node originated (e.g. `ui.commit`) — no response
/// expected, typically just forwards to the webview as a Tauri event.
pub type NotificationHandler<R> = Arc<dyn Fn(AppHandle<R>, String, Option<Value>) + Send + Sync>;

/// Supervises the Node sidecar that hosts Raycast extensions: spawns it
/// lazily on first use, restarts it after a crash or an unresponsive call,
/// and routes JSON-RPC messages over the length-prefixed stdio framing from
/// `protocol.rs` in both directions — Rust can call Node (`call`), and Node
/// can call Rust back (dispatched to `request_handler`) or notify it
/// (`notification_handler`), which is how the T21 imperative APIs and the
/// T22 UI-tree commit stream actually reach this process.
pub struct ExtensionHost<R: Runtime> {
    app: AppHandle<R>,
    process: Arc<Mutex<Option<RunningProcess>>>,
    pending: Arc<Mutex<HashMap<i64, oneshot::Sender<RpcMessage>>>>,
    next_id: AtomicI64,
    // std::sync::Mutex, not tokio's: these are set once from Tauri's
    // synchronous setup closure (no async context available there without
    // block_on ceremony) and only ever cloned quickly, never held across
    // an await point.
    request_handler: StdMutex<Option<RequestHandler<R>>>,
    notification_handler: StdMutex<Option<NotificationHandler<R>>>,
}

impl<R: Runtime> ExtensionHost<R> {
    pub fn new(app: AppHandle<R>) -> Self {
        Self {
            app,
            process: Arc::new(Mutex::new(None)),
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicI64::new(1),
            request_handler: StdMutex::new(None),
            notification_handler: StdMutex::new(None),
        }
    }

    /// Installs the handler for requests Node originates. Must be called
    /// before the sidecar is first used (typically right after `new`) —
    /// swapping it later races with an already-spawned reader task.
    pub fn set_request_handler(&self, handler: RequestHandler<R>) {
        *self.request_handler.lock().unwrap() = Some(handler);
    }

    pub fn set_notification_handler(&self, handler: NotificationHandler<R>) {
        *self.notification_handler.lock().unwrap() = Some(handler);
    }

    fn host_js_path(&self) -> Result<PathBuf, HostError> {
        let path = if cfg!(debug_assertions) {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../packages/extension-host/dist/host.cjs")
        } else {
            self.app
                .path()
                .resource_dir()
                .map_err(|e| HostError::Spawn(e.to_string()))?
                .join("extension-host/host.cjs")
        };
        if !path.exists() {
            return Err(HostError::MissingBundle(path));
        }
        Ok(path)
    }

    async fn ensure_started(&self) -> Result<(), HostError> {
        let mut guard = self.process.lock().await;
        if guard.is_some() {
            return Ok(());
        }

        let host_js = self.host_js_path()?;
        let sidecar = self
            .app
            .shell()
            .sidecar("node")
            .map_err(|e| HostError::Spawn(e.to_string()))?
            .args([host_js.to_string_lossy().to_string()])
            .set_raw_out(true);

        let (mut rx, child) = sidecar.spawn().map_err(|e| HostError::Spawn(e.to_string()))?;

        let pending = self.pending.clone();
        let process_for_reader = self.process.clone();
        let app_for_reader = self.app.clone();
        let request_handler = self.request_handler.lock().unwrap().clone();
        let notification_handler = self.notification_handler.lock().unwrap().clone();

        tauri::async_runtime::spawn(async move {
            let mut decoder = FrameDecoder::new();
            while let Some(event) = rx.recv().await {
                match event {
                    CommandEvent::Stdout(bytes) => match decoder.push(&bytes) {
                        Ok(messages) => {
                            for message in messages {
                                match message {
                                    RpcMessage::Response(ref response) => {
                                        let id = match &response.id {
                                            RpcId::Number(n) => *n,
                                            RpcId::String(_) => continue,
                                        };
                                        let mut pending = pending.lock().await;
                                        if let Some(sender) = pending.remove(&id) {
                                            let _ = sender.send(message);
                                        }
                                    }
                                    RpcMessage::Notification(notification) => {
                                        if let Some(handler) = &notification_handler {
                                            handler(app_for_reader.clone(), notification.method, notification.params);
                                        }
                                    }
                                    RpcMessage::Request(request) => {
                                        Self::handle_inbound_request(
                                            app_for_reader.clone(),
                                            &process_for_reader,
                                            request,
                                            request_handler.clone(),
                                        )
                                        .await;
                                    }
                                }
                            }
                        }
                        Err(e) => log::warn!("extension host: frame decode error: {e}"),
                    },
                    CommandEvent::Stderr(bytes) => {
                        // T32: was `log::debug!` — silently dropped regardless
                        // of `RUST_LOG`, since `tauri_plugin_log`'s level
                        // filter in `lib.rs::setup_window_chrome` is hardcoded
                        // to `LevelFilter::Info` (same gotcha
                        // `plans/perf-baseline.md`'s search-latency
                        // instrumentation already documents). Found live: a
                        // notification handler's thrown/rejected error
                        // (`rpc.ts`'s "log and swallow" path) writes here,
                        // and was completely invisible — masked a real
                        // functional bug (a store-installed extension's
                        // command silently never completing) through every
                        // prior wave's testing.
                        log::info!("extension host: {}", String::from_utf8_lossy(&bytes));
                    }
                    CommandEvent::Error(message) => {
                        log::warn!("extension host process error: {message}");
                    }
                    CommandEvent::Terminated(payload) => {
                        log::warn!("extension host terminated: {payload:?}");
                        break;
                    }
                    _ => {}
                }
            }
        });

        *guard = Some(RunningProcess { child });
        Ok(())
    }

    /// Dispatches an inbound request from Node to `request_handler` (or a
    /// "method not found" error if none is set / no handler matched) and
    /// writes the response frame straight back to the child's stdin.
    ///
    /// Takes `process` directly (the same `Arc` `self.process` points at,
    /// cloned into the reader task) rather than reaching back through
    /// managed app state to find `self` — this runs inside a `'static`
    /// spawned task that only has an `AppHandle` clone, not `&ExtensionHost`.
    async fn handle_inbound_request(
        app: AppHandle<R>,
        process: &Arc<Mutex<Option<RunningProcess>>>,
        request: RpcRequest,
        handler: Option<RequestHandler<R>>,
    ) {
        let response = match &handler {
            Some(handler) => match handler(app.clone(), request.method.clone(), request.params).await {
                Ok(result) => RpcResponse {
                    jsonrpc: "2.0".to_string(),
                    id: request.id,
                    result: Some(result),
                    error: None,
                },
                Err(error) => RpcResponse {
                    jsonrpc: "2.0".to_string(),
                    id: request.id,
                    result: None,
                    error: Some(super::protocol::RpcError { code: -32000, message: error.to_string(), data: None }),
                },
            },
            None => RpcResponse {
                jsonrpc: "2.0".to_string(),
                id: request.id,
                result: None,
                error: Some(super::protocol::RpcError {
                    code: -32601,
                    message: format!("Method not found: {}", request.method),
                    data: None,
                }),
            },
        };

        if let Ok(frame) = encode_frame(&RpcMessage::Response(response)) {
            if let Err(e) = write_frame_to(process, &frame).await {
                log::warn!("extension host: failed to write response frame: {e}");
            }
        }
    }

    async fn write_frame(&self, frame: &[u8]) -> Result<(), HostError> {
        write_frame_to(&self.process, frame).await
    }

    async fn kill(&self) {
        let mut guard = self.process.lock().await;
        if let Some(running) = guard.take() {
            let _ = running.child.kill();
        }
    }

    pub async fn call(&self, method: &str, params: Option<Value>) -> Result<Value, HostError> {
        self.ensure_started().await?;

        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);

        let request = RpcMessage::Request(RpcRequest {
            jsonrpc: "2.0".to_string(),
            id: RpcId::Number(id),
            method: method.to_string(),
            params,
        });
        let frame = encode_frame(&request).map_err(|e| HostError::Protocol(e.to_string()))?;
        self.write_frame(&frame).await?;

        match tokio::time::timeout(CALL_TIMEOUT, rx).await {
            Ok(Ok(RpcMessage::Response(response))) => {
                if let Some(error) = response.error {
                    Err(HostError::Remote { code: error.code, message: error.message })
                } else {
                    Ok(response.result.unwrap_or(Value::Null))
                }
            }
            Ok(Ok(_)) => Err(HostError::Protocol("expected a response message".into())),
            Ok(Err(_)) => Err(HostError::Protocol("response channel closed".into())),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                self.kill().await;
                Err(HostError::Unresponsive)
            }
        }
    }

    /// Like [`Self::call`], but distinguishes a slow call from a wedged
    /// host instead of treating every overrun as fatal.
    ///
    /// `call`'s contract — time out, kill the process, report
    /// [`HostError::Unresponsive`] — is right for the interactive paths it
    /// serves, where 10 seconds of silence really does mean something is
    /// broken. It is wrong for Import/Export: an extension with a lot of
    /// data can legitimately take longer than any fixed timeout, and
    /// killing the shared host process would take every *other* extension
    /// down with it over one slow export.
    ///
    /// So on overrun this probes the host with `host.ping` (a handler that
    /// does nothing but reply) and branches on the answer:
    /// - **ping answers** → the event loop is turning, so the call is
    ///   merely slow. Keep waiting up to [`SLOW_CALL_CEILING`], then fail
    ///   just this call with [`HostError::CallTooSlow`], process intact.
    /// - **ping doesn't answer** → the host really is wedged, so fall back
    ///   to `call`'s behavior: kill it and report `Unresponsive`.
    ///
    /// Known limitation: extensions share one Node process, so a hook doing
    /// *synchronous* CPU work blocks the event loop and the ping with it —
    /// indistinguishable from a hang, and killed as one. Import/Export
    /// hooks are documented as needing to stay async and yield.
    pub async fn call_checked(&self, method: &str, params: Option<Value>) -> Result<Value, HostError> {
        self.ensure_started().await?;

        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);

        let request = RpcMessage::Request(RpcRequest {
            jsonrpc: "2.0".to_string(),
            id: RpcId::Number(id),
            method: method.to_string(),
            params,
        });
        let frame = encode_frame(&request).map_err(|e| HostError::Protocol(e.to_string()))?;
        self.write_frame(&frame).await?;

        // `&mut rx` (not `rx`) so a timeout leaves the receiver intact —
        // the call is still genuinely in flight and may still answer while
        // the health check runs, and re-awaiting it below must not lose
        // that answer.
        let mut rx = rx;
        if let Ok(result) = tokio::time::timeout(HEALTH_CHECK_AFTER, &mut rx).await {
            return Self::interpret_response(result);
        }

        if self.ping().await.is_err() {
            self.pending.lock().await.remove(&id);
            self.kill().await;
            return Err(HostError::Unresponsive);
        }

        // Host is alive, so this call is merely slow — give it the rest of
        // its rope, and on expiry fail only this call.
        match tokio::time::timeout(SLOW_CALL_CEILING, &mut rx).await {
            Ok(result) => Self::interpret_response(result),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(HostError::CallTooSlow {
                    method: method.to_string(),
                    seconds: (HEALTH_CHECK_AFTER + SLOW_CALL_CEILING).as_secs(),
                })
            }
        }
    }

    /// The liveness probe behind [`Self::call_checked`]. Never kills the
    /// process on failure — deciding what a failed ping means is the
    /// caller's job.
    async fn ping(&self) -> Result<(), HostError> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);

        let request = RpcMessage::Request(RpcRequest {
            jsonrpc: "2.0".to_string(),
            id: RpcId::Number(id),
            method: "host.ping".to_string(),
            params: None,
        });
        let frame = encode_frame(&request).map_err(|e| HostError::Protocol(e.to_string()))?;
        self.write_frame(&frame).await?;

        match tokio::time::timeout(PING_TIMEOUT, rx).await {
            Ok(Ok(_)) => Ok(()),
            _ => {
                self.pending.lock().await.remove(&id);
                Err(HostError::Unresponsive)
            }
        }
    }

    fn interpret_response(result: Result<RpcMessage, oneshot::error::RecvError>) -> Result<Value, HostError> {
        match result {
            Ok(RpcMessage::Response(response)) => {
                if let Some(error) = response.error {
                    Err(HostError::Remote { code: error.code, message: error.message })
                } else {
                    Ok(response.result.unwrap_or(Value::Null))
                }
            }
            Ok(_) => Err(HostError::Protocol("expected a response message".into())),
            Err(_) => Err(HostError::Protocol("response channel closed".into())),
        }
    }

    /// Sends a notification to Node — no response expected. Used for
    /// fire-and-forget signals like "run this command" or "invoke this
    /// callback", where the resulting effects (UI-tree commits) stream
    /// back independently via notifications Node sends the other way.
    pub async fn notify(&self, method: &str, params: Option<Value>) -> Result<(), HostError> {
        self.ensure_started().await?;
        let message = RpcMessage::Notification(super::protocol::RpcNotification {
            jsonrpc: "2.0".to_string(),
            method: method.to_string(),
            params,
        });
        let frame = encode_frame(&message).map_err(|e| HostError::Protocol(e.to_string()))?;
        self.write_frame(&frame).await
    }

}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::test::{mock_builder, MockRuntime};

    fn host_bundle_built() -> bool {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../packages/extension-host/dist/host.cjs")
            .exists()
    }

    fn mock_app_handle() -> AppHandle<MockRuntime> {
        let app = mock_builder()
            .plugin(tauri_plugin_shell::init())
            .build(tauri::generate_context!())
            .expect("failed to build mock app");
        app.handle().clone()
    }

    #[tokio::test]
    async fn hello_world_round_trips_through_the_real_sidecar() {
        if !host_bundle_built() {
            eprintln!("skipping: run `pnpm --filter @openray/extension-host build` first");
            return;
        }

        let host = ExtensionHost::new(mock_app_handle());
        let result = host.call("host.hello", None).await.expect("hello call failed");
        assert_eq!(
            result.get("message").and_then(|v| v.as_str()),
            Some("hello from extension host")
        );

        let ping = host.call("host.ping", None).await.expect("ping failed");
        assert_eq!(ping.get("pong").and_then(|v| v.as_bool()), Some(true));
    }

    #[tokio::test]
    async fn unknown_method_surfaces_as_remote_error() {
        if !host_bundle_built() {
            eprintln!("skipping: run `pnpm --filter @openray/extension-host build` first");
            return;
        }

        let host = ExtensionHost::new(mock_app_handle());
        let err = host.call("does.not.exist", None).await.unwrap_err();
        match err {
            HostError::Remote { code, .. } => assert_eq!(code, -32601),
            other => panic!("expected Remote error, got {other:?}"),
        }
    }
}
