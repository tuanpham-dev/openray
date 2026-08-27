use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use arboard::Clipboard;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::sync::oneshot;

use crate::application::state::AppState;
use crate::domain::ports::PasteInjector;
use crate::error::Error;
use crate::infrastructure::paste::SystemPasteInjector;

pub const EXTENSION_UI_COMMIT_EVENT: &str = "extension-ui-commit";
pub const EXTENSION_TOAST_EVENT: &str = "extension-toast";
pub const EXTENSION_HUD_EVENT: &str = "extension-hud";
/// Tells the palette to return to the root search view. Carries
/// `{ clearSearchBar: bool }`.
pub const EXTENSION_POP_TO_ROOT_EVENT: &str = "extension-pop-to-root";
/// Tells the palette to show a confirm dialog. Carries `{ requestId, title,
/// message, primaryButtonTitle, dismissButtonTitle }` — the frontend answers
/// via the `resolve_confirm_alert` Tauri command, keyed by `requestId`.
pub const EXTENSION_CONFIRM_ALERT_EVENT: &str = "extension-confirm-alert";

static NEXT_TOAST_ID: AtomicU64 = AtomicU64::new(1);

/// Tracks in-flight `confirmAlert` requests: `host.system.confirmAlert`'s
/// handler blocks on the receiver half until `resolve_confirm_alert` (a
/// Tauri command the frontend's confirm-dialog UI calls on the user's
/// answer) sends the matching sender half. Mirrors
/// `ExtensionHost`'s own `pending: HashMap<_, oneshot::Sender<_>>`
/// request-tracking, one layer further out — that one matches Node's RPC
/// responses back to Rust's own outbound calls; this one matches a human's
/// dialog answer back to an extension's inbound one.
#[derive(Default)]
pub struct ConfirmAlertRegistry {
    pending: Mutex<HashMap<String, oneshot::Sender<bool>>>,
}

impl ConfirmAlertRegistry {
    fn register(&self) -> (String, oneshot::Receiver<bool>) {
        let id = crate::infrastructure::time::new_row_id("confirm-alert");
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id.clone(), tx);
        (id, rx)
    }

    /// Called by the `resolve_confirm_alert` Tauri command. `false` (not
    /// an error) when `request_id` is unknown — already resolved, or the
    /// palette was closed and reopened between the dialog showing and the
    /// user answering it, both harmless double-answers rather than bugs.
    pub fn resolve(&self, request_id: &str, confirmed: bool) -> bool {
        match self.pending.lock().unwrap().remove(request_id) {
            Some(tx) => {
                let _ = tx.send(confirmed);
                true
            }
            None => false,
        }
    }
}

/// Dispatches a request Node originated (the T21 imperative APIs reaching
/// back into Rust) to a real implementation. Returns the JSON value to send
/// back as the RPC result, or an error message sent back as an RPC error.
///
/// Deliberately a small, explicit match rather than a pluggable registry —
/// this is a fixed, known set of methods, not something extensions or
/// plugins add to at runtime.
pub async fn dispatch_request<R: Runtime>(app: AppHandle<R>, method: String, params: Option<Value>) -> Result<Value, Error> {
    match method.as_str() {
        "host.clipboard.copy" => clipboard_copy(&app, params),
        "host.clipboard.paste" => clipboard_paste(&app, params),
        "host.clipboard.read" => clipboard_read(),
        "host.clipboard.readText" => clipboard_read(),
        "host.clipboard.clear" => clipboard_clear(),
        "host.toast.show" => toast_show(&app, params),
        "host.toast.update" => toast_update(&app, params),
        "host.toast.hide" => toast_hide(&app, params),
        "host.system.showHUD" => hud_show(&app, params),
        "host.storage.get" => Ok(storage(&app)?.extension_storage.get(&param_str(&params, "extensionId")?, &param_str(&params, "key")?)?),
        "host.storage.set" => {
            let value = params.as_ref().and_then(|p| p.get("value")).cloned().unwrap_or(Value::Null);
            storage(&app)?.extension_storage.set(&param_str(&params, "extensionId")?, &param_str(&params, "key")?, &value)?;
            Ok(Value::Null)
        }
        "host.storage.remove" => {
            storage(&app)?.extension_storage.remove(&param_str(&params, "extensionId")?, &param_str(&params, "key")?)?;
            Ok(Value::Null)
        }
        "host.storage.all" => Ok(storage(&app)?.extension_storage.all(&param_str(&params, "extensionId")?)?),
        "host.storage.clear" => {
            storage(&app)?.extension_storage.clear(&param_str(&params, "extensionId")?)?;
            Ok(Value::Null)
        }
        "host.system.open" => system_open(&app, params),
        "host.system.closeMainWindow" => close_main_window(&app, params),
        "host.system.popToRoot" => pop_to_root(&app, params),
        "host.system.showInFinder" => show_in_finder(&app, params),
        "host.system.getApplications" => get_applications(),
        "host.system.getSelectedText" => get_selected_text(),
        "host.system.trash" => trash(params),
        "host.system.getFrontmostApplication" => get_frontmost_application(),
        "host.system.confirmAlert" => confirm_alert(&app, params).await,
        "host.system.refreshRootCommands" => refresh_root_commands(&app, params).await,
        "host.system.getScriptDirectories" => get_script_directories(&app),
        "host.system.allowAssetDirectory" => allow_asset_directory(&app, params),
        "host.window.isAvailable" => window_is_available(),
        "host.window.getFocusedFrame" => window_get_focused_frame(),
        "host.window.setFrame" => window_set_frame(params),
        "host.window.getWorkArea" => window_get_work_area(params),
        "host.window.listDisplays" => window_list_displays(),
        "host.window.setFullscreen" => window_set_fullscreen(params),
        "host.window.getSettings" => window_get_settings(&app),
        "host.translate.getSettings" => translate_get_settings(&app),
        "host.translate.setTargetLanguage" => translate_set_target_language(&app, params),
        "host.notes.getSettings" => notes_get_settings(&app),
        "host.ai.getSettings" => ai_get_settings(&app),
        "host.clipboardHistory.list" => clipboard_history_list(&app),
        "host.clipboardHistory.get" => clipboard_history_get(&app, params),
        "host.clipboardHistory.delete" => clipboard_history_delete(&app, params),
        "host.clipboardHistory.paste" => clipboard_history_paste(&app, params),
        "host.clipboardHistory.pasteImage" => clipboard_history_paste(&app, params),
        "host.clipboardHistory.clearAll" => clipboard_history_clear_all(&app),
        "host.screenshots.getSettings" => screenshots_get_settings(&app),
        "host.screenshots.query" => screenshots_query(&app),
        "host.screenshots.pasteWithFormat" => screenshots_paste_with_format(&app, params),
        "host.screenshots.copyWithFormat" => screenshots_copy_with_format(&app, params),
        "host.screenshots.drop" => screenshots_drop(&app, params),
        "host.screenshots.dropSupported" => screenshots_drop_supported(),
        "host.screenshots.open" => screenshots_open(&app, params),
        "host.screenshots.pasteLatest" => screenshots_paste_latest(&app),
        "host.screenshots.dropLatest" => screenshots_drop_latest(&app),
        "host.screenshots.setPinned" => screenshots_set_pinned(&app, params),
        "host.fileSearch.getSettings" => file_search_get_settings(&app),
        "host.fileSearch.query" => file_search_query(&app, params),
        "host.menuBar.list" => menu_bar_list(),
        "host.menuBar.activate" => menu_bar_activate(&app, params),
        "host.window.canListWindows" => window_can_list_windows(),
        "host.window.list" => window_list_windows(&app),
        "host.window.focus" => window_focus(&app, params),
        "host.window.close" => window_close(params),
        "host.extensionWindow.open" => extension_window_open(&app, params),
        "host.extensionWindow.close" => extension_window_close(&app, params),
        "host.extensionWindow.focus" => extension_window_focus(&app, params),
        other => Err(Error::msg(format!("{other} is not implemented yet"))),
    }
}

/// Dispatches a notification Node originated — no response expected.
/// `ui.commit` (the T22 UI-tree stream) forwards straight to the webview
/// as a Tauri event; `extension.rootCommands` (T14) is the other real
/// one, updating `RootCommandProvider` in place.
pub fn dispatch_notification<R: Runtime>(app: AppHandle<R>, method: String, params: Option<Value>) {
    match method.as_str() {
        "ui.commit" => {
            // T24: every mount tags its commits with the label of the
            // window it belongs to (`windowLabel`, defaulting to the
            // palette's own `"main"` label for the two pre-T24 mount
            // variants that never learned about extension windows —
            // `runner.ts`'s `runCommand`/`runRootCommandView`) so a second,
            // concurrently open extension window's tree can't leak into
            // the palette's `extensionTreeStore` (a single global
            // singleton per webview) or vice versa. `emit_to` — not
            // `emit` — is what makes that isolation real: each window's
            // own `eventBridge.ts` only ever receives commits actually
            // routed to it.
            let (window_label, commit) = parse_ui_commit(params);
            if let Err(e) = app.emit_to(&window_label, EXTENSION_UI_COMMIT_EVENT, commit) {
                log::warn!("failed to forward ui.commit to window '{window_label}': {e}");
            }
        }
        "extension.rootCommands" => root_commands_pushed(&app, params),
        "host.log" => {
            log::debug!("extension: {params:?}");
        }
        other => {
            log::debug!("unhandled notification from extension host: {other}");
        }
    }
}

/// Pulls a `ui.commit` notification's `{ windowLabel, commit }` payload
/// apart — pure, so the parsing/defaulting logic is unit-testable without
/// needing a real `emit_to` delivery to a window that only a live app
/// actually has (see this module's tests for why `emit_to` itself isn't
/// exercised here). `windowLabel` defaults to the palette's own label
/// (`window::PALETTE_WINDOW_LABEL`, literally `"main"`) for any payload
/// that omits it — every current mount variant sends it explicitly, but a
/// malformed or pre-T24-shaped payload still routes somewhere sane instead
/// of silently dropping the commit.
fn parse_ui_commit(params: Option<Value>) -> (String, Value) {
    match params {
        Some(Value::Object(mut map)) => {
            let label = map
                .get("windowLabel")
                .and_then(Value::as_str)
                .unwrap_or(crate::infrastructure::window::PALETTE_WINDOW_LABEL)
                .to_string();
            let commit = map.remove("commit").unwrap_or(Value::Null);
            (label, commit)
        }
        _ => (crate::infrastructure::window::PALETTE_WINDOW_LABEL.to_string(), Value::Null),
    }
}

/// `runner.ts`'s response to `extension.runRootProviderList` — the
/// listing function's `RootCommand[]` result, pushed back
/// unprompted. Silently dropped (with a log line) on a malformed payload
/// rather than panicking: this is untrusted-ish data from a sidecar
/// process, and a malformed push from one buggy extension must not take
/// down anything else already in search results.
fn root_commands_pushed<R: Runtime>(app: &AppHandle<R>, params: Option<Value>) {
    let Some(state) = app.try_state::<AppState>() else { return };
    let Some(params) = params else {
        log::warn!("extension.rootCommands notification with no params");
        return;
    };
    let (Some(extension_id), Some(command_name)) = (
        params.get("extensionId").and_then(Value::as_str),
        params.get("commandName").and_then(Value::as_str),
    ) else {
        log::warn!("extension.rootCommands notification missing extensionId/commandName");
        return;
    };
    let commands: Vec<crate::infrastructure::extension_host::protocol::RootCommand> =
        match params.get("commands").cloned().map(serde_json::from_value) {
            Some(Ok(commands)) => commands,
            Some(Err(e)) => {
                log::warn!("extension.rootCommands from '{extension_id}': malformed commands array: {e}");
                return;
            }
            None => {
                log::warn!("extension.rootCommands from '{extension_id}' missing a commands array");
                return;
            }
        };
    let supports_inline_query = params.get("supportsInlineQuery").and_then(Value::as_bool).unwrap_or(false);
    // Same "find in the cached list" pattern `ExtensionsRegistry::is_enabled`
    // already uses — `list()` is generation-cached, so this isn't a fresh
    // query per push.
    let extension_icon = state.extensions.list().into_iter().find(|e| e.id == extension_id).and_then(|e| e.icon);
    state.root_commands.set_rows(extension_id, command_name, supports_inline_query, extension_icon, commands);
}

/// Resolves `Clipboard.copy`/`paste` content into the text to place on the
/// clipboard.
///
/// The API accepts a bare string or `{ text, file, html }`. `file` is
/// carried as its path: setting a real file reference needs the
/// `text/uri-list` clipboard target, which arboard can't write — the path
/// is the closest honest equivalent, and it's what a file manager's text
/// flavour exposes anyway. `html` falls back to its text alternative
/// rather than erroring, so an extension that sends only rich content
/// still copies something usable.
fn extract_text(params: &Option<Value>) -> Option<String> {
    let content = params.as_ref()?.get("content")?;
    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }
    for key in ["text", "file", "html"] {
        if let Some(value) = content.get(key).and_then(|v| v.as_str()) {
            return Some(value.to_string());
        }
    }
    None
}

fn concealed(params: &Option<Value>) -> bool {
    params
        .as_ref()
        .and_then(|p| p.get("options"))
        .and_then(|o| o.get("concealed"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn set_clipboard_text<R: Runtime>(app: &AppHandle<R>, params: &Option<Value>) -> Result<String, Error> {
    let text = extract_text(params).ok_or_else(|| Error::msg("clipboard content missing a text value"))?;

    // Registered before the copy so the polling watcher can't observe the
    // value first and record it.
    if concealed(params) {
        if let Some(state) = app.try_state::<AppState>() {
            state.clipboard_watcher.suppress_text(&text);
        }
    }

    let mut clipboard = Clipboard::new().map_err(|e| Error::msg(e.to_string()))?;
    clipboard.set_text(text.clone()).map_err(|e| Error::msg(e.to_string()))?;
    Ok(text)
}

fn clipboard_copy<R: Runtime>(app: &AppHandle<R>, params: Option<Value>) -> Result<Value, Error> {
    set_clipboard_text(app, &params)?;
    Ok(Value::Null)
}

/// `Clipboard.paste` puts the content on the clipboard *and* pastes it into
/// the frontmost app, which is what separates it from `copy`.
///
/// This used to alias `copy`, because a hidden palette kept input focus and
/// the keystroke had nowhere to land. Focus is now handed back when the
/// palette hides, so the real behaviour is available.
fn clipboard_paste<R: Runtime>(app: &AppHandle<R>, params: Option<Value>) -> Result<Value, Error> {
    set_clipboard_text(app, &params)?;

    // The palette must be out of the way first: the injected keystroke
    // goes to whatever holds focus once it's gone.
    let _ = crate::infrastructure::window::hide_palette_any(app);
    SystemPasteInjector.paste_current_clipboard()?;
    Ok(Value::Null)
}

fn clipboard_read() -> Result<Value, Error> {
    let mut clipboard = Clipboard::new().map_err(|e| Error::msg(e.to_string()))?;
    let Ok(text) = clipboard.get_text() else { return Ok(json!({})) };

    // A file-manager copy exposes `file://` URIs as its text flavour;
    // Raycast reports those under `file`, so report both rather than
    // leaving an extension to parse the URI itself.
    let file = crate::infrastructure::clipboard_watcher::parse_clipboard_file_paths(&text)
        .first()
        .map(|path| path.to_string_lossy().into_owned());

    match file {
        Some(path) => Ok(json!({ "text": text, "file": path })),
        None => Ok(json!({ "text": text })),
    }
}

fn clipboard_clear() -> Result<Value, Error> {
    let mut clipboard = Clipboard::new().map_err(|e| Error::msg(e.to_string()))?;
    clipboard.clear().map_err(|e| Error::msg(e.to_string()))?;
    Ok(Value::Null)
}

fn param_str(params: &Option<Value>, key: &str) -> Result<String, Error> {
    params
        .as_ref()
        .and_then(|p| p.get(key))
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| Error::msg(format!("missing '{key}' parameter")))
}

fn param_f64(params: &Option<Value>, key: &str) -> Result<f64, Error> {
    params
        .as_ref()
        .and_then(|p| p.get(key))
        .and_then(Value::as_f64)
        .ok_or_else(|| Error::msg(format!("missing '{key}' parameter")))
}

fn rect_to_json(r: crate::infrastructure::platform::window_manage::Rect) -> Value {
    json!({ "x": r.x, "y": r.y, "width": r.w, "height": r.h })
}

/// Whether this session can read/write window geometry at all (e.g.
/// `false` on Wayland) — distinct from whether a window is currently
/// focused, which every other `host.window.*` call already degrades to
/// `null`/`false` for on its own. Native `commands()` gates the entire
/// preset list on this alone, never on focus state, so the listing needs
/// this as its own signal rather than inferring it from a focus-dependent
/// call returning empty.
fn window_is_available() -> Result<Value, Error> {
    use crate::infrastructure::platform::window_manage as wm;
    Ok(json!(wm::available()))
}

/// `host.window.getFocusedFrame()` — folds `window_manage::target()` +
/// `frame()` into one round trip: a TS caller never needs the raw window
/// id for anything except passing it back into `setFrame`/`getWorkArea`/
/// `setFullscreen`, so returning it alongside the rect avoids a second
/// RPC just to resolve "what window am I even acting on". `null` when
/// there's no resolvable focused window (matches every other
/// `window_manage` call's "degrade to a falsy value, never error"
/// philosophy — see that module's own doc comment).
fn window_get_focused_frame() -> Result<Value, Error> {
    use crate::infrastructure::platform::window_manage as wm;
    let Some(id) = wm::target() else { return Ok(Value::Null) };
    let Some(r) = wm::frame(&id) else { return Ok(Value::Null) };
    let mut frame = rect_to_json(r);
    if let Value::Object(map) = &mut frame {
        map.insert("windowId".to_string(), json!(id));
    }
    Ok(frame)
}

fn window_set_frame(params: Option<Value>) -> Result<Value, Error> {
    use crate::infrastructure::platform::window_manage as wm;
    let id = param_str(&params, "windowId")?;
    let rect = wm::Rect { x: param_f64(&params, "x")?, y: param_f64(&params, "y")?, w: param_f64(&params, "width")?, h: param_f64(&params, "height")? };
    Ok(json!(wm::set_frame(&id, rect)))
}

fn window_get_work_area(params: Option<Value>) -> Result<Value, Error> {
    use crate::infrastructure::platform::window_manage as wm;
    let id = param_str(&params, "windowId")?;
    Ok(wm::work_area(&id).map(rect_to_json).unwrap_or(Value::Null))
}

fn window_list_displays() -> Result<Value, Error> {
    use crate::infrastructure::platform::window_manage as wm;
    Ok(json!(wm::displays().into_iter().map(rect_to_json).collect::<Vec<_>>()))
}

fn window_set_fullscreen(params: Option<Value>) -> Result<Value, Error> {
    use crate::infrastructure::platform::window_manage as wm;
    let id = param_str(&params, "windowId")?;
    let fullscreen = params.as_ref().and_then(|p| p.get("fullscreen")).and_then(Value::as_bool).unwrap_or(false);
    Ok(json!(wm::set_fullscreen(&id, fullscreen)))
}

/// Exposes the app-wide Settings pane's `windowGap`/`halfCycling` — these
/// are NOT window-management-owned data (they live in
/// `AppState.settings`, shared app config also read by other features),
/// so they can't move into the extension's own storage; the extension
/// must read them live on every command, matching the now-deleted native
/// provider's own "read fresh every call" behavior for the same fields
/// (`window_gap`/`half_cycling_enabled`, T18).
fn window_get_settings<R: Runtime>(app: &AppHandle<R>) -> Result<Value, Error> {
    let state = app.try_state::<AppState>().ok_or_else(|| Error::msg("app state not managed"))?;
    let s = state.settings.get();
    Ok(json!({ "windowGap": s.window_gap, "halfCycling": s.half_cycling }))
}

/// `host.translate.getSettings()` (T22) — `translateTargetLanguage`/
/// `translateSourceLanguage`/`translatePrimaryAction`/`translateHistoryEnabled`
/// are app-wide `AppState.settings` fields (edited from Settings →
/// Translate, a pane that stays native — a generic app preference, not
/// extension-owned data), so the extension reads them live on every call
/// rather than caching a copy, same reasoning as `window_get_settings`.
fn translate_get_settings<R: Runtime>(app: &AppHandle<R>) -> Result<Value, Error> {
    let state = app.try_state::<AppState>().ok_or_else(|| Error::msg("app state not managed"))?;
    let s = state.settings.get();
    Ok(json!({
        "targetLanguage": s.translate_target_language,
        "sourceLanguage": s.translate_source_language,
        "primaryAction": s.translate_primary_action,
        "historyEnabled": s.translate_history_enabled,
    }))
}

/// `host.translate.setTargetLanguage({ code })` (T22) — the one translate
/// setting the view actually persists on change (an explicit user pick of
/// the target language; source language is deliberately never persisted,
/// matching native `TranslateView.tsx`'s own behavior). Reuses the normal
/// `SettingsStore::update` path, so this also emits the same
/// `settings-changed` event a Settings-pane edit would — the pane picks up
/// the new value live if it happens to be open.
fn translate_set_target_language<R: Runtime>(app: &AppHandle<R>, params: Option<Value>) -> Result<Value, Error> {
    let code = param_str(&params, "code")?;
    let state = app.try_state::<AppState>().ok_or_else(|| Error::msg("app state not managed"))?;
    let mut settings = state.settings.get();
    settings.translate_target_language = code.to_string();
    state.settings.update(settings)?;
    Ok(Value::Null)
}

/// `host.notes.getSettings()` (T26) — `notesAlwaysOnTop` stays an
/// app-wide `AppState.settings` field (edited from Settings → Notes, a
/// pane that stays native — a generic app preference affecting native
/// window *creation*, not extension-owned data), read live on every call.
/// No `setAlwaysOnTop` counterpart: unlike translate's target language,
/// nothing inside the Notes window itself ever edits this — only the
/// Settings pane does, via the existing `update_settings` path.
fn notes_get_settings<R: Runtime>(app: &AppHandle<R>) -> Result<Value, Error> {
    let state = app.try_state::<AppState>().ok_or_else(|| Error::msg("app state not managed"))?;
    let s = state.settings.get();
    Ok(json!({ "alwaysOnTop": s.notes_always_on_top }))
}

/// `host.ai.getSettings()` (T27) — the AI-related fields of `AppState.settings`
/// (model choice, personalization profile, skill directories, custom CLI
/// presets), read live. Same reasoning as `notes_get_settings`: these are
/// ordinary app preferences edited from Settings → General/AI, not
/// extension-owned data — the `ai` extension only ever reads them.
fn ai_get_settings<R: Runtime>(app: &AppHandle<R>) -> Result<Value, Error> {
    let state = app.try_state::<AppState>().ok_or_else(|| Error::msg("app state not managed"))?;
    let s = state.settings.get();
    Ok(json!({
        "aiDefaultModel": s.ai_default_model,
        "aiQuickModel": s.ai_quick_model,
        "aiProfile": s.ai_profile,
        "aiSkillDirs": s.ai_skill_dirs,
        "aiCustomClis": s.ai_custom_clis,
    }))
}

/// `host.clipboardHistory.list()` (T28) — `ClipboardHistoryProvider::list()`
/// verbatim. Widens the asset protocol to the images directory on every
/// call, same idempotent-and-cheap reasoning as `allow_asset_directory`
/// (T20) — an entry's `imagePath` (rendered as a `List.Item.icon`) can't
/// resolve via `convertFileSrc` until this has run at least once, and the
/// extension has no other natural moment to call it itself.
fn clipboard_history_list<R: Runtime>(app: &AppHandle<R>) -> Result<Value, Error> {
    let state = app.try_state::<AppState>().ok_or_else(|| Error::msg("app state not managed"))?;
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = app.asset_protocol_scope().allow_directory(dir.join("clipboard-images"), true);
    }
    Ok(json!(state.clipboard.list()))
}

/// `host.clipboardHistory.get({ id })` (T28) — a single entry, or `null`.
fn clipboard_history_get<R: Runtime>(app: &AppHandle<R>, params: Option<Value>) -> Result<Value, Error> {
    let state = app.try_state::<AppState>().ok_or_else(|| Error::msg("app state not managed"))?;
    let id = param_str(&params, "id")?;
    Ok(json!(state.clipboard.find(&id)))
}

/// `host.clipboardHistory.delete({ id })` (T28).
fn clipboard_history_delete<R: Runtime>(app: &AppHandle<R>, params: Option<Value>) -> Result<Value, Error> {
    let state = app.try_state::<AppState>().ok_or_else(|| Error::msg("app state not managed"))?;
    let id = param_str(&params, "id")?;
    state.clipboard.delete(&id).map_err(Error::msg)?;
    Ok(Value::Null)
}

/// `host.clipboardHistory.clearAll()` (T28) — kept even though the task's
/// literal 5-method surface omits it: native's own "Clear All" action is
/// cheap to keep and dropping it silently would be a real capability
/// regression, not a disclosed scope cut (same reasoning T27 used to add
/// `manage-providers`/`create-agent` beyond its own file-by-file port).
fn clipboard_history_clear_all<R: Runtime>(app: &AppHandle<R>) -> Result<Value, Error> {
    let state = app.try_state::<AppState>().ok_or_else(|| Error::msg("app state not managed"))?;
    state.clipboard.clear_all().map_err(Error::msg)?;
    Ok(Value::Null)
}

/// `host.clipboardHistory.paste`/`.pasteImage({ id })` (T28) — both names
/// from the task's bridge surface resolve here: `ClipboardEntry::kind`
/// already tells the extension which one it *should* call, but
/// `ClipboardHistoryProvider::paste` itself already branches on `kind`
/// internally (image entries: copy to the system clipboard, then replay
/// the paste keystroke; text/file: type directly) — so both names are
/// simply two spellings of the identical, already-correct native
/// operation, and neither can be called "wrong". Hides the palette first,
/// same reasoning native `paste_clipboard_entry` documented: the injected
/// keystroke must land on whatever window regains focus once the palette
/// is gone, not on the palette itself.
fn clipboard_history_paste<R: Runtime>(app: &AppHandle<R>, params: Option<Value>) -> Result<Value, Error> {
    let state = app.try_state::<AppState>().ok_or_else(|| Error::msg("app state not managed"))?;
    let id = param_str(&params, "id")?;
    crate::infrastructure::window::hide_palette_any(app)?;
    state.clipboard.paste(&id).map_err(Error::msg)?;
    Ok(Value::Null)
}

/// `host.screenshots.getSettings()` (T29) — same reasoning as
/// `notes_get_settings`/`ai_get_settings`: ordinary app preferences edited
/// from Settings → Screenshots (`ScreenshotsPane.tsx`, which stays
/// native), read live rather than owned by the extension.
fn screenshots_get_settings<R: Runtime>(app: &AppHandle<R>) -> Result<Value, Error> {
    let state = app.try_state::<AppState>().ok_or_else(|| Error::msg("app state not managed"))?;
    let s = state.settings.get();
    Ok(json!({
        "searchScopes": s.screenshot_search_scopes,
        "videoExtensions": s.screenshot_video_extensions,
        "gridColumns": s.screenshot_grid_columns,
        "ocrEnabled": s.screenshot_ocr_enabled,
        "pasteFormat": s.screenshot_paste_format,
        "storageDuration": s.screenshot_storage_duration,
    }))
}

/// `host.screenshots.query()` (T29) — `ScreenshotsProvider::list()`
/// verbatim (scan+OCR+thumbnail join, 3s cache) plus the same
/// `spawn_index_sweep()` kick native `list_screenshots` fired on every
/// call — an open grid's own refetch (on `screenshots-ocr-updated`) is
/// what keeps results filling in as the sweep progresses.
fn screenshots_query<R: Runtime>(app: &AppHandle<R>) -> Result<Value, Error> {
    let state = app.try_state::<AppState>().ok_or_else(|| Error::msg("app state not managed"))?;
    let entries = state.screenshots.list();
    state.screenshots.spawn_index_sweep();
    Ok(json!(entries))
}

/// `host.screenshots.pasteWithFormat({ path, format })` (T29) — the
/// grid's one paste action for any entry, always passing an explicit
/// format (the extension resolves "default" itself from
/// `getSettings().pasteFormat` before calling this, rather than this
/// handler guessing a fallback the way native's `Option<String>` param
/// once did).
fn screenshots_paste_with_format<R: Runtime>(app: &AppHandle<R>, params: Option<Value>) -> Result<Value, Error> {
    let state = app.try_state::<AppState>().ok_or_else(|| Error::msg("app state not managed"))?;
    let path = param_str(&params, "path")?;
    let format = param_str(&params, "format")?;
    crate::infrastructure::window::hide_palette_any(app)?;
    state.screenshots.paste_path_as(&path, &format).map_err(Error::msg)?;
    Ok(Value::Null)
}

/// `host.screenshots.copyWithFormat({ path, format })` (T29) — not in the
/// plan's own literal 4-method bridge surface, added because the grid's
/// "Copy as …" actions have no other way to work at all without it (same
/// "fill a real gap rather than silently drop it" reasoning T28 used for
/// `clearAll`). No palette hide, matching native `copy_screenshot`.
fn screenshots_copy_with_format<R: Runtime>(app: &AppHandle<R>, params: Option<Value>) -> Result<Value, Error> {
    let state = app.try_state::<AppState>().ok_or_else(|| Error::msg("app state not managed"))?;
    let path = param_str(&params, "path")?;
    let format = param_str(&params, "format")?;
    state.screenshots.copy_path_as(&path, &format).map_err(Error::msg)?;
    Ok(Value::Null)
}

/// `host.screenshots.drop({ path })` (T29) — drop-at-cursor for an
/// arbitrary grid entry, not just the latest one `dropLatest` covers.
/// Added for the same reason `copyWithFormat` was.
fn screenshots_drop<R: Runtime>(app: &AppHandle<R>, params: Option<Value>) -> Result<Value, Error> {
    let state = app.try_state::<AppState>().ok_or_else(|| Error::msg("app state not managed"))?;
    let path = param_str(&params, "path")?;
    crate::infrastructure::window::hide_palette_any(app)?;
    state.screenshots.drop_path_at_cursor(&path).map_err(Error::msg)?;
    Ok(Value::Null)
}

/// `host.screenshots.dropSupported()` (T29) — mirrors native
/// `screenshot_drop_supported`, drives whether the grid's action panel
/// offers "Drop at Cursor" at all and whether the root-provider's
/// "Drop Latest Screenshot" row exists.
fn screenshots_drop_supported() -> Result<Value, Error> {
    Ok(json!(crate::infrastructure::platform::drop_at_cursor::supported()))
}

/// `host.screenshots.open({ path })` (T29) — mirrors native
/// `open_screenshot` exactly (opens with the OS default handler).
fn screenshots_open<R: Runtime>(app: &AppHandle<R>, params: Option<Value>) -> Result<Value, Error> {
    use tauri_plugin_opener::OpenerExt;
    let path = param_str(&params, "path")?;
    app.opener().open_path(path, None::<&str>).map_err(|e| Error::msg(e.to_string()))?;
    Ok(Value::Null)
}

/// `host.screenshots.pasteLatest()` (T29) — the root-provider's "Paste
/// Latest Screenshot" row. Returns `{ found: bool }` rather than erroring
/// when there's nothing to paste, so the extension can show its own toast
/// (matching T28's own extension-side-toast pattern) instead of native's
/// now-deleted `CommandProvider::execute`'s inline `self.toast(...)` call.
fn screenshots_paste_latest<R: Runtime>(app: &AppHandle<R>) -> Result<Value, Error> {
    let state = app.try_state::<AppState>().ok_or_else(|| Error::msg("app state not managed"))?;
    let Some(entry) = state.screenshots.find_latest_image() else {
        return Ok(json!({ "found": false }));
    };
    crate::infrastructure::window::hide_palette_any(app)?;
    state.screenshots.paste_path(&entry.path).map_err(Error::msg)?;
    Ok(json!({ "found": true }))
}

/// `host.screenshots.dropLatest()` (T29) — the root-provider's "Drop
/// Latest Screenshot" row, same `{ found: bool }` shape as `pasteLatest`.
fn screenshots_drop_latest<R: Runtime>(app: &AppHandle<R>) -> Result<Value, Error> {
    let state = app.try_state::<AppState>().ok_or_else(|| Error::msg("app state not managed"))?;
    let Some(entry) = state.screenshots.find_latest_image() else {
        return Ok(json!({ "found": false }));
    };
    crate::infrastructure::window::hide_palette_any(app)?;
    state.screenshots.drop_path_at_cursor(&entry.path).map_err(Error::msg)?;
    Ok(json!({ "found": true }))
}

/// `host.screenshots.setPinned({ path, pinned })` — exempts (or
/// re-includes) `path` from the storage-duration trash sweep
/// (`trash_expired_entries`).
fn screenshots_set_pinned<R: Runtime>(app: &AppHandle<R>, params: Option<Value>) -> Result<Value, Error> {
    let state = app.try_state::<AppState>().ok_or_else(|| Error::msg("app state not managed"))?;
    let path = param_str(&params, "path")?;
    let pinned = params.as_ref().and_then(|p| p.get("pinned")).and_then(Value::as_bool).ok_or_else(|| Error::msg("missing 'pinned' parameter"))?;
    state.screenshots.set_pinned(&path, pinned);
    Ok(Value::Null)
}

/// `host.fileSearch.getSettings()` — the File Search pane's one field
/// (`FileSearchPane.tsx`, which stays native), read live, same reasoning
/// as `screenshots_get_settings`.
fn file_search_get_settings<R: Runtime>(app: &AppHandle<R>) -> Result<Value, Error> {
    let state = app.try_state::<AppState>().ok_or_else(|| Error::msg("app state not managed"))?;
    Ok(json!({ "scopes": state.settings.get().file_search_scopes }))
}

/// `host.fileSearch.query({ query })` — fuzzy filename search over the
/// SQLite-cached index, plus the same `spawn_index_sweep()` kick
/// `host.screenshots.query` uses to keep the index filling in as it's
/// used.
fn file_search_query<R: Runtime>(app: &AppHandle<R>, params: Option<Value>) -> Result<Value, Error> {
    let state = app.try_state::<AppState>().ok_or_else(|| Error::msg("app state not managed"))?;
    let query = param_str(&params, "query").unwrap_or_default();
    let entries = state.file_search.query(&query);
    state.file_search.spawn_index_sweep();
    Ok(json!(entries))
}

/// `host.system.getScriptDirectories()` (T20) — the Settings pane's
/// user-configured script-command directories (`GeneralPane.tsx`'s
/// "Script Directories" field). Live app-wide Settings state, not
/// extension-owned data — same reasoning as `window_get_settings` above.
fn get_script_directories<R: Runtime>(app: &AppHandle<R>) -> Result<Value, Error> {
    let state = app.try_state::<AppState>().ok_or_else(|| Error::msg("app state not managed"))?;
    Ok(json!(state.settings.get().script_directories))
}

/// `host.system.allowAssetDirectory({ path })` (T20) — widens the asset
/// protocol's scope to cover a user-configured script directory so a
/// script-relative icon image (resolved to an absolute path outside
/// `tauri.conf.json`'s static scope) can actually be served via
/// `convertFileSrc`. Mirrors native `ScriptCommandProvider::scripts()`'s
/// own per-scan `allow_directory` call exactly — idempotent, safe to
/// call on every listing refresh.
fn allow_asset_directory<R: Runtime>(app: &AppHandle<R>, params: Option<Value>) -> Result<Value, Error> {
    let path = param_str(&params, "path")?;
    let _ = app.asset_protocol_scope().allow_directory(path, true);
    Ok(Value::Null)
}

/// Whether this session can enumerate windows at all (e.g. `false` on
/// Wayland, which has no portal-level "list every window" API). Distinct
/// from `window_manage::available()`/`host.window.isAvailable` (T18) —
/// a different platform module, geometry I/O rather than enumeration,
/// that happens to share the same underlying X11-connectivity check on
/// this backend but is a logically separate capability. Native
/// `NavigationProvider::commands()` used this to hide "Switch Windows"
/// entirely on an unsupported platform; as a static `mode: "view"`
/// extension command switch-windows can't hide itself from search the
/// same way (no root-provider gating, matching the plan's "plain List
/// view" scope), so it instead calls this once on mount to show an
/// explanatory empty state instead of a silently-empty list.
fn window_can_list_windows() -> Result<Value, Error> {
    use crate::infrastructure::platform::window_list;
    Ok(json!(window_list::available()))
}

/// `host.menuBar.list()` (T30) — reuses `application::navigation::list_menu_items()`
/// verbatim (an accessibility-API menu introspection + mnemonic-strip +
/// path-flatten pass, per-OS via `infrastructure::platform::menu_bar`).
fn menu_bar_list() -> Result<Value, Error> {
    Ok(json!(crate::application::navigation::list_menu_items()))
}

/// `host.menuBar.activate({ token })` (T30) — activates *before* hiding
/// the palette, the opposite order from every paste/drop bridge method
/// T28/T29 added: matches native `activate_menu_item`'s own ordering
/// exactly (not changed here) — the target app is presumably expected to
/// still be frontmost/focused at the moment the accessibility API fires
/// the activation, unlike a paste/drop keystroke injected *after* the
/// palette (and its own focus) is out of the way.
fn menu_bar_activate<R: Runtime>(app: &AppHandle<R>, params: Option<Value>) -> Result<Value, Error> {
    let token = param_str(&params, "token")?;
    crate::infrastructure::platform::menu_bar::activate(&token);
    crate::infrastructure::window::hide_palette_any(app)?;
    Ok(Value::Null)
}

/// `host.window.list()` (T19) — reuses `NavigationProvider::list_windows()`
/// verbatim, the same app-icon-match-then-self-extracted-icon-fallback
/// logic the native Switch Windows view already used (see
/// `application::navigation`'s doc comment): `icon` is either a
/// resolvable file path (an installed app's theme icon) or a
/// `data:image/png;base64,...` URI (a window-specific icon extracted
/// straight from `_NET_WM_ICON`, only present when no app match exists).
fn window_list_windows<R: Runtime>(app: &AppHandle<R>) -> Result<Value, Error> {
    let state = app.try_state::<AppState>().ok_or_else(|| Error::msg("app state not managed"))?;
    let windows = state.navigation.list_windows();
    Ok(json!(windows
        .into_iter()
        .map(|w| json!({ "id": w.id, "title": w.title, "appName": w.app_name, "icon": w.icon }))
        .collect::<Vec<_>>()))
}

/// Mirrors `api::navigation::focus_window` exactly, including the
/// hide-before-activate ordering that fn's own doc comment explains is
/// required on Linux (XFWM won't raise a window on `_NET_ACTIVE_WINDOW`
/// alone unless the palette is already unmapped first).
fn window_focus<R: Runtime>(app: &AppHandle<R>, params: Option<Value>) -> Result<Value, Error> {
    use crate::infrastructure::platform::window_list;
    let id = param_str(&params, "id")?;
    crate::infrastructure::window::hide_palette_any(app)?;
    Ok(json!(window_list::activate(&id)))
}

/// Deliberately does not hide the palette first — matches native
/// `close_window`'s asymmetry with `focus_window`.
fn window_close(params: Option<Value>) -> Result<Value, Error> {
    use crate::infrastructure::platform::window_list;
    let id = param_str(&params, "id")?;
    Ok(json!(window_list::close(&id)))
}

/// `host.extensionWindow.open(options)` (T24) — the `Window` shim's
/// backing call, routed through `AppState.extension_windows` since this
/// otherwise-generic `dispatch_request<R: Runtime>` can't itself construct
/// a `WebviewWindowBuilder` (Wry-only) — see `ExtensionWindows`'s doc
/// comment. Every option is optional; unset ones fall back to
/// `ExtensionWindowOptions::default()`'s values. Returns the freshly
/// generated window label the caller must pass to `close`/`focus` and tag
/// its `ui.commit`s with.
fn extension_window_open<R: Runtime>(app: &AppHandle<R>, params: Option<Value>) -> Result<Value, Error> {
    let state = app.try_state::<AppState>().ok_or_else(|| Error::msg("app state not managed"))?;
    let defaults = crate::infrastructure::window::ExtensionWindowOptions::default();
    let options = crate::infrastructure::window::ExtensionWindowOptions {
        title: params.as_ref().and_then(|p| p.get("title")).and_then(Value::as_str).map(str::to_string).unwrap_or(defaults.title),
        width: params.as_ref().and_then(|p| p.get("width")).and_then(Value::as_f64).unwrap_or(defaults.width),
        height: params.as_ref().and_then(|p| p.get("height")).and_then(Value::as_f64).unwrap_or(defaults.height),
        decorations: params.as_ref().and_then(|p| p.get("decorations")).and_then(Value::as_bool).unwrap_or(defaults.decorations),
        always_on_top: params.as_ref().and_then(|p| p.get("alwaysOnTop")).and_then(Value::as_bool).unwrap_or(defaults.always_on_top),
    };
    let label = state.extension_windows.open(options).map_err(|e| Error::msg(e.to_string()))?;
    Ok(json!(label))
}

fn extension_window_close<R: Runtime>(app: &AppHandle<R>, params: Option<Value>) -> Result<Value, Error> {
    let state = app.try_state::<AppState>().ok_or_else(|| Error::msg("app state not managed"))?;
    let window_label = param_str(&params, "windowLabel")?;
    state.extension_windows.close(&window_label)?;
    Ok(Value::Null)
}

fn extension_window_focus<R: Runtime>(app: &AppHandle<R>, params: Option<Value>) -> Result<Value, Error> {
    let state = app.try_state::<AppState>().ok_or_else(|| Error::msg("app state not managed"))?;
    let window_label = param_str(&params, "windowLabel")?;
    state.extension_windows.focus(&window_label)?;
    Ok(Value::Null)
}

/// The storage store lives in AppState, which the mock runtime used in
/// tests never manages — an explicit error there beats a panic.
fn storage<R: Runtime>(app: &AppHandle<R>) -> Result<tauri::State<'_, AppState>, Error> {
    app.try_state::<AppState>().ok_or_else(|| Error::msg("storage unavailable: app state not managed"))
}

/// `open(target, application?)` — a URL or a filesystem path, optionally
/// with a specific application.
fn system_open<R: Runtime>(app: &AppHandle<R>, params: Option<Value>) -> Result<Value, Error> {
    use tauri_plugin_opener::OpenerExt;

    let target = param_str(&params, "target")?;
    // Raycast's Application is {name, path, ...}; a plain string is also
    // accepted. The opener wants a program name/path.
    let with = params.as_ref().and_then(|p| p.get("application")).and_then(|a| {
        a.as_str().map(str::to_string).or_else(|| a.get("path").or_else(|| a.get("name")).and_then(Value::as_str).map(str::to_string))
    });

    let looks_like_path = target.starts_with('/') || target.starts_with('~');
    let result = if looks_like_path {
        app.opener().open_path(&target, with.as_deref())
    } else {
        app.opener().open_url(&target, with.as_deref())
    };
    result.map_err(|e| Error::msg(e.to_string()))?;
    Ok(Value::Null)
}

fn emit_pop_to_root<R: Runtime>(app: &AppHandle<R>, clear_search: bool) {
    let _ = app.emit(EXTENSION_POP_TO_ROOT_EVENT, json!({ "clearSearchBar": clear_search }));
}

fn close_main_window<R: Runtime>(app: &AppHandle<R>, params: Option<Value>) -> Result<Value, Error> {
    crate::infrastructure::window::hide_palette_any(app)?;

    // Raycast pops to root on close unless the extension asked to be
    // suspended in place (PopToRootType.Suspended).
    let pop_type = params
        .as_ref()
        .and_then(|p| p.get("popToRootType"))
        .and_then(Value::as_str)
        .unwrap_or("default");
    if pop_type != "suspended" {
        let clear = params
            .as_ref()
            .and_then(|p| p.get("clearRootSearch"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        emit_pop_to_root(app, clear);
    }
    Ok(Value::Null)
}

fn pop_to_root<R: Runtime>(app: &AppHandle<R>, params: Option<Value>) -> Result<Value, Error> {
    // Raycast clears the search bar by default on popToRoot.
    let clear = params
        .as_ref()
        .and_then(|p| p.get("clearSearchBar"))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    emit_pop_to_root(app, clear);
    Ok(Value::Null)
}

/// XDG has no "reveal in file manager" standard, so the containing
/// directory is opened instead — the closest portable equivalent.
fn show_in_finder<R: Runtime>(app: &AppHandle<R>, params: Option<Value>) -> Result<Value, Error> {
    use tauri_plugin_opener::OpenerExt;

    let path = param_str(&params, "path")?;
    let target = std::path::Path::new(&path);
    let dir = if target.is_dir() {
        target.to_path_buf()
    } else {
        target.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| target.to_path_buf())
    };
    app.opener().open_path(dir.to_string_lossy(), None::<&str>).map_err(|e| Error::msg(e.to_string()))?;
    Ok(Value::Null)
}

fn get_applications() -> Result<Value, Error> {
    use crate::domain::ports::AppScanner;

    let apps: Vec<Value> = crate::infrastructure::platform::PlatformAppScanner::new()
        .scan()
        .into_iter()
        .map(|app| json!({ "name": app.name, "path": app.id }))
        .collect();
    Ok(Value::Array(apps))
}

/// `None` (nothing selected, or this platform/session can't read a live
/// selection — see `SelectionReader`'s doc comment) becomes `null`, not an
/// error: `getSelectedText()` throwing on "nothing selected" would make
/// the common case of an extension probing for a selection needlessly
/// exception-driven.
fn get_selected_text() -> Result<Value, Error> {
    use crate::domain::ports::SelectionReader;
    use crate::infrastructure::selection::SystemSelectionReader;

    Ok(json!(SystemSelectionReader.read_selected_text()))
}

fn trash(params: Option<Value>) -> Result<Value, Error> {
    use crate::domain::ports::Trash as TrashPort;
    use crate::infrastructure::trash::SystemTrash;

    let path = param_str(&params, "path")?;
    SystemTrash.trash(&path).map_err(Error::msg)?;
    Ok(Value::Null)
}

fn get_frontmost_application() -> Result<Value, Error> {
    use crate::domain::ports::FrontmostAppReader;
    use crate::infrastructure::frontmost_app::SystemFrontmostAppReader;

    Ok(json!(SystemFrontmostAppReader.frontmost_application()))
}

/// `confirmAlert(options)` — shows the palette's confirm surface and waits
/// for the human's answer before resolving. `options` mirrors Raycast's
/// shape: `{ title, message?, primaryAction？: { title }, dismissAction?:
/// { title } }`.
///
/// A closed channel (the sender dropped without sending — the palette
/// window itself was destroyed while the dialog was up, the one way
/// `resolve_confirm_alert` can never run for this id) resolves to `false`
/// rather than erroring the extension's `await confirmAlert(...)` call:
/// "the user did not confirm" is the honest reading of "no answer will
/// ever come," and matches what a real dismiss produces.
async fn confirm_alert<R: Runtime>(app: &AppHandle<R>, params: Option<Value>) -> Result<Value, Error> {
    let state = app.try_state::<AppState>().ok_or_else(|| Error::msg("app state not managed"))?;
    let (request_id, rx) = state.confirm_alerts.register();

    let title = param_str(&params, "title")?;
    let message = params.as_ref().and_then(|p| p.get("message")).and_then(Value::as_str).map(str::to_string);
    let primary_button_title = params
        .as_ref()
        .and_then(|p| p.get("primaryAction"))
        .and_then(|a| a.get("title"))
        .and_then(Value::as_str)
        .unwrap_or("OK")
        .to_string();
    let dismiss_button_title = params
        .as_ref()
        .and_then(|p| p.get("dismissAction"))
        .and_then(|a| a.get("title"))
        .and_then(Value::as_str)
        .unwrap_or("Cancel")
        .to_string();

    app.emit(
        EXTENSION_CONFIRM_ALERT_EVENT,
        json!({
            "requestId": request_id,
            "title": title,
            "message": message,
            "primaryButtonTitle": primary_button_title,
            "dismissButtonTitle": dismiss_button_title,
        }),
    )
    .map_err(|e| Error::msg(e.to_string()))?;

    Ok(json!(rx.await.unwrap_or(false)))
}

/// `refreshRootCommands()` (T14) — re-requests the calling extension's
/// `root-provider` listing. Fire-and-forget exactly like the initial
/// startup push (`extension_commands::launch_root_provider_listing`):
/// the refreshed rows arrive later via `extension.rootCommands`, this
/// call doesn't wait for them.
async fn refresh_root_commands<R: Runtime>(app: &AppHandle<R>, params: Option<Value>) -> Result<Value, Error> {
    let state = app.try_state::<AppState>().ok_or_else(|| Error::msg("app state not managed"))?;
    let extension_id = param_str(&params, "extensionId")?;
    let command_name = state
        .root_commands
        .host_command_name(&extension_id)
        .ok_or_else(|| Error::msg(format!("'{extension_id}' has no root-provider listing to refresh yet")))?;

    crate::application::extension_commands::launch_root_provider_listing(app, &extension_id, &command_name).await?;
    Ok(Value::Null)
}

fn toast_show<R: Runtime>(app: &AppHandle<R>, params: Option<Value>) -> Result<Value, Error> {
    let id = format!("toast-{}", NEXT_TOAST_ID.fetch_add(1, Ordering::SeqCst));
    let mut payload = params.unwrap_or_else(|| json!({}));
    if let Value::Object(map) = &mut payload {
        map.insert("id".to_string(), json!(id));
    }
    app.emit(EXTENSION_TOAST_EVENT, payload)?;
    Ok(json!(id))
}

/// Real `@raycast/api` toasts update by plain property mutation after
/// `show()` (`toast.style = ...; toast.title = ...`) — this re-emits the
/// same `extension-toast` event shape `toast_show` uses, just keeping the
/// caller-supplied `id` instead of minting a new one. The frontend's own
/// toast state (`App.tsx`'s `setToast`) already treats every
/// `extension-toast` event as "replace the currently displayed toast", so
/// no frontend change is needed — re-emitting under the same id is
/// sufficient to update it in place instead of appearing as a second toast.
fn toast_update<R: Runtime>(app: &AppHandle<R>, params: Option<Value>) -> Result<Value, Error> {
    param_str(&params, "id")?;
    app.emit(EXTENSION_TOAST_EVENT, params.unwrap_or_else(|| json!({})))?;
    Ok(Value::Null)
}

/// A HUD is not a toast: Raycast shows it as a brief, standalone
/// confirmation with no styling, actions, or dismissal affordance. It gets
/// its own event so the UI can render it that way instead of dressing it
/// up as an extension notification.
///
/// Known difference: Raycast closes the main window first and floats the
/// HUD over the desktop. This renders it in place, since a separate
/// always-on-top overlay window is a larger piece of work.
fn hud_show<R: Runtime>(app: &AppHandle<R>, params: Option<Value>) -> Result<Value, Error> {
    let title = params
        .as_ref()
        .and_then(|p| p.get("title"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    app.emit(EXTENSION_HUD_EVENT, json!({ "title": title }))?;
    Ok(Value::Null)
}

fn toast_hide<R: Runtime>(app: &AppHandle<R>, params: Option<Value>) -> Result<Value, Error> {
    let id = params.as_ref().and_then(|p| p.get("id")).and_then(|v| v.as_str()).unwrap_or_default();
    app.emit(EXTENSION_TOAST_EVENT, json!({ "id": id, "hide": true }))?;
    Ok(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tauri::test::mock_builder;
    use tauri::Listener;

    fn mock_app() -> tauri::AppHandle<tauri::test::MockRuntime> {
        let app = mock_builder().build(tauri::generate_context!()).expect("failed to build mock app");
        app.handle().clone()
    }

    #[test]
    fn copy_content_accepts_a_bare_string_or_an_object() {
        let bare = Some(json!({ "content": "hello" }));
        assert_eq!(extract_text(&bare).as_deref(), Some("hello"));

        let object = Some(json!({ "content": { "text": "hello" } }));
        assert_eq!(extract_text(&object).as_deref(), Some("hello"));
    }

    #[test]
    fn copy_content_falls_back_to_file_and_html() {
        // Raycast's ClipboardContent is {text, file, html}; an extension
        // sending only one of the latter two should still copy something
        // rather than get an error.
        let file = Some(json!({ "content": { "file": "/tmp/a.png" } }));
        assert_eq!(extract_text(&file).as_deref(), Some("/tmp/a.png"));

        let html = Some(json!({ "content": { "html": "<b>hi</b>" } }));
        assert_eq!(extract_text(&html).as_deref(), Some("<b>hi</b>"));
    }

    #[test]
    fn text_wins_when_several_flavours_are_present() {
        let content = Some(json!({ "content": { "html": "<b>hi</b>", "text": "hi" } }));
        assert_eq!(extract_text(&content).as_deref(), Some("hi"));
    }

    #[test]
    fn concealed_is_read_from_copy_options() {
        assert!(concealed(&Some(json!({ "content": "s3cret", "options": { "concealed": true } }))));
        assert!(!concealed(&Some(json!({ "content": "public", "options": { "concealed": false } }))));
        // Absent options must not conceal — the default is to record.
        assert!(!concealed(&Some(json!({ "content": "public" }))));
        assert!(!concealed(&None));
    }

    #[tokio::test]
    async fn unknown_method_is_an_error() {
        let app = mock_app();
        let err = dispatch_request(app, "host.does.not.exist".into(), None).await.unwrap_err();
        assert!(err.to_string().contains("not implemented"));
    }

    #[tokio::test]
    async fn toast_show_emits_the_toast_event_and_returns_an_id() {
        let app = mock_app();
        let received: Arc<Mutex<Option<Value>>> = Arc::new(Mutex::new(None));
        let received_clone = received.clone();
        app.listen(EXTENSION_TOAST_EVENT, move |event| {
            let payload: Value = serde_json::from_str(event.payload()).unwrap();
            *received_clone.lock().unwrap() = Some(payload);
        });

        let result = dispatch_request(app, "host.toast.show".into(), Some(json!({ "title": "Hi", "style": "SUCCESS" })))
            .await
            .expect("toast_show should succeed");
        let id = result.as_str().expect("result should be a toast id string");
        assert!(id.starts_with("toast-"));

        let payload = received.lock().unwrap().clone().expect("expected a toast event to have been emitted");
        assert_eq!(payload.get("title").and_then(|v| v.as_str()), Some("Hi"));
        assert_eq!(payload.get("id").and_then(|v| v.as_str()), Some(id));
    }

    /// T32: real `@raycast/api` toasts update by plain property mutation
    /// after `show()` — found live-broken (a store-installed extension's
    /// toast never reflected its own post-`show()` title/style change)
    /// because no `host.toast.update` handler existed at all.
    #[tokio::test]
    async fn toast_update_re_emits_under_the_same_id() {
        let app = mock_app();
        let received: Arc<Mutex<Option<Value>>> = Arc::new(Mutex::new(None));
        let received_clone = received.clone();
        app.listen(EXTENSION_TOAST_EVENT, move |event| {
            let payload: Value = serde_json::from_str(event.payload()).unwrap();
            *received_clone.lock().unwrap() = Some(payload);
        });

        dispatch_request(app, "host.toast.update".into(), Some(json!({ "id": "toast-0", "title": "Done", "style": "SUCCESS" })))
            .await
            .expect("toast_update should succeed");

        let payload = received.lock().unwrap().clone().expect("expected a toast event to have been emitted");
        assert_eq!(payload.get("id").and_then(|v| v.as_str()), Some("toast-0"));
        assert_eq!(payload.get("title").and_then(|v| v.as_str()), Some("Done"));
    }

    #[tokio::test]
    async fn toast_update_requires_an_id() {
        let app = mock_app();
        let err = dispatch_request(app, "host.toast.update".into(), Some(json!({ "title": "Done" }))).await.unwrap_err();
        assert!(err.to_string().contains("id"));
    }

    // T24: `dispatch_notification`'s `ui.commit` arm now calls `emit_to`
    // (targeted delivery to one window), not `emit` (broadcast) — a plain
    // `AppHandle::listen` global listener never receives an `emit_to` in
    // Tauri's own event model (only a listener registered on the matching
    // `WebviewWindow` does), so a mock-runtime round trip through
    // `dispatch_notification` itself can't observe the emitted payload the
    // way the pre-T24 `emit`-based version could. `parse_ui_commit` — the
    // pure extraction `dispatch_notification` delegates to — is what's
    // actually worth unit-testing here; real per-window delivery is a live
    // concern, verified in the sandboxed Xvfb pass instead (same rationale
    // the `host.window.*`/`host.extensionWindow.*` handlers above already
    // document for not exercising real window I/O in this test module).

    #[test]
    fn parse_ui_commit_extracts_the_window_label_and_unwraps_the_commit() {
        let commit = json!({ "kind": "snapshot", "snapshot": { "rootId": "n0", "nodes": {} } });
        let (label, parsed) = parse_ui_commit(Some(json!({ "windowLabel": "ext-window-0", "commit": commit })));
        assert_eq!(label, "ext-window-0");
        assert_eq!(parsed, commit);
    }

    #[test]
    fn parse_ui_commit_without_a_window_label_defaults_to_the_palette() {
        // Every current mount variant sends `windowLabel` explicitly
        // (`runCommand`/`runRootCommandView` send `"main"`,
        // `openExtensionWindow` sends its own fresh label) — this documents
        // the fallback stays correct for a malformed/pre-T24 payload that
        // omits it entirely.
        let commit = json!({ "kind": "snapshot", "snapshot": { "rootId": "n0", "nodes": {} } });
        let (label, parsed) = parse_ui_commit(Some(json!({ "commit": commit })));
        assert_eq!(label, crate::infrastructure::window::PALETTE_WINDOW_LABEL);
        assert_eq!(parsed, commit);
    }

    #[test]
    fn parse_ui_commit_on_a_non_object_payload_defaults_to_the_palette_with_no_commit() {
        assert_eq!(
            parse_ui_commit(None),
            (crate::infrastructure::window::PALETTE_WINDOW_LABEL.to_string(), Value::Null)
        );
    }

    // `host.window.*` handlers that reach `infrastructure::platform::window_manage`
    // are deliberately not exercised here — that module does real,
    // possibly-mutating X11 I/O against whatever `DISPLAY` this test
    // process happens to inherit (this dev machine's own real desktop
    // when run interactively), and `set_frame`/`set_fullscreen` are not
    // safe to let a test reach for the same reason no live app instance
    // may be disturbed by anything in this session. Only the
    // parameter-validation paths that return before ever calling into
    // `window_manage` are tested here.

    // `host.window.list`/`focus`/`close` (T19) reach
    // `infrastructure::platform::window_list` — real, possibly-mutating
    // X11 I/O for `focus`/`close` — so only the paths that return before
    // that (missing app state, missing params) are tested here, same
    // rationale as the `window_manage` handlers above.

    #[tokio::test]
    async fn window_list_requires_app_state() {
        let app = mock_app();
        let err = dispatch_request(app, "host.window.list".into(), None).await.unwrap_err();
        assert!(err.to_string().contains("app state not managed"));
    }

    #[tokio::test]
    async fn window_focus_requires_an_id() {
        let app = mock_app();
        let err = dispatch_request(app, "host.window.focus".into(), Some(json!({}))).await.unwrap_err();
        assert!(err.to_string().contains("'id' parameter"));
    }

    #[tokio::test]
    async fn window_close_requires_an_id() {
        let app = mock_app();
        let err = dispatch_request(app, "host.window.close".into(), Some(json!({}))).await.unwrap_err();
        assert!(err.to_string().contains("'id' parameter"));
    }

    // `host.extensionWindow.open/close/focus` (T24) reach
    // `AppState.extension_windows`, which does real `WebviewWindowBuilder`/
    // window-creation I/O — not safe to exercise against a live app
    // instance in a test process, same rationale as every other
    // window-touching handler above. Only the paths that return before
    // that (missing app state, missing params) are tested here.

    #[tokio::test]
    async fn extension_window_open_requires_app_state() {
        let app = mock_app();
        let err = dispatch_request(app, "host.extensionWindow.open".into(), None).await.unwrap_err();
        assert!(err.to_string().contains("app state not managed"));
    }

    #[tokio::test]
    async fn extension_window_close_requires_a_window_label() {
        let app = mock_app();
        let err = dispatch_request(app, "host.extensionWindow.close".into(), Some(json!({}))).await.unwrap_err();
        assert!(err.to_string().contains("app state not managed") || err.to_string().contains("'windowLabel' parameter"));
    }

    #[tokio::test]
    async fn extension_window_focus_requires_a_window_label() {
        let app = mock_app();
        let err = dispatch_request(app, "host.extensionWindow.focus".into(), Some(json!({}))).await.unwrap_err();
        assert!(err.to_string().contains("app state not managed") || err.to_string().contains("'windowLabel' parameter"));
    }

    #[tokio::test]
    async fn window_set_frame_requires_all_four_dimensions() {
        let app = mock_app();
        let err = dispatch_request(app, "host.window.setFrame".into(), Some(json!({ "windowId": "1" }))).await.unwrap_err();
        assert!(err.to_string().contains("'x' parameter"));
    }

    #[tokio::test]
    async fn window_get_work_area_requires_a_window_id() {
        let app = mock_app();
        let err = dispatch_request(app, "host.window.getWorkArea".into(), Some(json!({}))).await.unwrap_err();
        assert!(err.to_string().contains("'windowId' parameter"));
    }

    #[tokio::test]
    async fn window_set_fullscreen_requires_a_window_id() {
        let app = mock_app();
        let err = dispatch_request(app, "host.window.setFullscreen".into(), Some(json!({ "fullscreen": true }))).await.unwrap_err();
        assert!(err.to_string().contains("'windowId' parameter"));
    }

    #[tokio::test]
    async fn window_get_settings_requires_app_state() {
        let app = mock_app();
        let err = dispatch_request(app, "host.window.getSettings".into(), None).await.unwrap_err();
        assert!(err.to_string().contains("app state not managed"));
    }

    #[tokio::test]
    async fn get_script_directories_requires_app_state() {
        let app = mock_app();
        let err = dispatch_request(app, "host.system.getScriptDirectories".into(), None).await.unwrap_err();
        assert!(err.to_string().contains("app state not managed"));
    }

    #[tokio::test]
    async fn allow_asset_directory_requires_a_path() {
        let app = mock_app();
        let err = dispatch_request(app, "host.system.allowAssetDirectory".into(), Some(json!({}))).await.unwrap_err();
        assert!(err.to_string().contains("'path' parameter"));
    }

    #[tokio::test]
    async fn notes_get_settings_requires_app_state() {
        let app = mock_app();
        let err = dispatch_request(app, "host.notes.getSettings".into(), None).await.unwrap_err();
        assert!(err.to_string().contains("app state not managed"));
    }

    #[tokio::test]
    async fn ai_get_settings_requires_app_state() {
        let app = mock_app();
        let err = dispatch_request(app, "host.ai.getSettings".into(), None).await.unwrap_err();
        assert!(err.to_string().contains("app state not managed"));
    }

    #[tokio::test]
    async fn translate_get_settings_requires_app_state() {
        let app = mock_app();
        let err = dispatch_request(app, "host.translate.getSettings".into(), None).await.unwrap_err();
        assert!(err.to_string().contains("app state not managed"));
    }

    #[tokio::test]
    async fn translate_set_target_language_requires_a_code_param() {
        let app = mock_app();
        let err = dispatch_request(app, "host.translate.setTargetLanguage".into(), Some(json!({}))).await.unwrap_err();
        assert!(err.to_string().contains("'code' parameter"));
    }

    #[tokio::test]
    async fn translate_set_target_language_requires_app_state() {
        let app = mock_app();
        let err = dispatch_request(app, "host.translate.setTargetLanguage".into(), Some(json!({ "code": "de" }))).await.unwrap_err();
        assert!(err.to_string().contains("app state not managed"));
    }

    #[tokio::test]
    async fn clipboard_copy_requires_text_content() {
        let app = mock_app();
        let err = dispatch_request(app, "host.clipboard.copy".into(), Some(json!({}))).await.unwrap_err();
        assert!(err.to_string().contains("text value"));
    }

    #[tokio::test]
    async fn confirm_alert_requires_app_state() {
        let app = mock_app();
        let err = dispatch_request(app, "host.system.confirmAlert".into(), Some(json!({ "title": "Sure?" }))).await.unwrap_err();
        assert!(err.to_string().contains("app state not managed"));
    }

    #[tokio::test]
    async fn confirm_alert_registry_delivers_the_resolved_answer_to_the_waiting_receiver() {
        let registry = ConfirmAlertRegistry::default();
        let (request_id, rx) = registry.register();

        assert!(registry.resolve(&request_id, true));
        assert!(rx.await.unwrap());
    }

    #[test]
    fn resolving_an_unknown_confirm_alert_id_reports_not_found_rather_than_panicking() {
        let registry = ConfirmAlertRegistry::default();
        assert!(!registry.resolve("no-such-id", true));
    }

    #[tokio::test]
    async fn a_confirm_alert_receiver_whose_sender_was_dropped_resolves_to_false() {
        // Simulates the window closing mid-dialog: nothing ever calls
        // `resolve`, so `register`'s sender is dropped when the registry
        // itself is — `confirm_alert`'s `rx.await.unwrap_or(false)` is
        // what turns that into "not confirmed" rather than a panic.
        let registry = ConfirmAlertRegistry::default();
        let (_, rx) = registry.register();
        drop(registry);
        assert!(!rx.await.unwrap_or(false));
    }
}
