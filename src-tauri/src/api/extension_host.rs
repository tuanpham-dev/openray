use serde_json::{json, Value};
use tauri::State;

use crate::application::state::AppState;
use crate::infrastructure::window;

/// Fires and forgets — the command stays mounted indefinitely, streaming
/// UI-tree commits back via the `extension-ui-commit` event as they happen,
/// not as this call's return value. Preference errors come back
/// synchronously with the `missing_required_preferences:` prefix the
/// frontend matches on.
///
/// Returns the command's declared manifest mode ("view" / "no-view" /
/// "menu-bar") so the frontend can decide whether to switch the palette to
/// the extension view at all — a root-search launch of a no-view command
/// must run headlessly, same as a hotkey-triggered one
/// (`ExtensionCommandProvider::execute`), not open an empty view stuck
/// waiting for UI commits that command will never send. Falls back to
/// `"view"` for an id somehow not found in either the manifest registry
/// or (T14) `RootCommandProvider` — matches this call's own prior,
/// mode-blind behavior — rather than failing the launch over a lookup
/// miss. `command_name` here is the same either-a-real-command-or-a-
/// contributed-row id `extension_commands::launch` resolves; a
/// contributed row's own `opens_view` flag stands in for a manifest mode
/// it doesn't have.
///
/// `argument` carries the argument-bar's collected value, when the frontend
/// launches a command that declared `arguments[]` — `App.tsx`'s
/// `quicklink-argument` submit handler calls this directly (instead of the
/// generic `run_command_with_argument`) for exactly this reason: it's the
/// only entry point that's mode-aware, so a *view*-mode command with an
/// argument still opens its view once mounted.
/// `arguments` is keyed by the manifest's own argument names — the palette
/// collects a value per declared field, so nothing has to be inferred here.
/// `positional_argument` is the one-value alternative for callers that have
/// a value but no field name (an inline root row, Quick AI's Tab shortcut);
/// it is mapped onto whichever argument the manifest declares first.
#[tauri::command]
pub async fn run_extension_command(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    extension_id: String,
    command_name: String,
    arguments: Option<std::collections::HashMap<String, String>>,
    positional_argument: Option<String>,
) -> Result<String, String> {
    let mut arguments = arguments.unwrap_or_default();
    // Callers that have a value but no field name — an inline root row, or
    // Quick AI's Tab shortcut — can't build the keyed map themselves, so
    // the manifest's first argument name is filled in for them here.
    if let Some(value) = positional_argument {
        if arguments.is_empty() {
            if let Some(name) = state
                .extensions
                .installed_commands()
                .into_iter()
                .find(|c| c.extension_id == extension_id && c.name == command_name)
                .and_then(|c| c.arguments.into_iter().next())
                .map(|a| a.name)
            {
                arguments.insert(name, value);
            } else {
                // A root-provider row has no manifest arguments; its
                // synthesized field is named "argument".
                arguments.insert("argument".to_string(), value);
            }
        }
    }
    let manifest_mode = state
        .extensions
        .installed_commands()
        .into_iter()
        .find(|c| c.extension_id == extension_id && c.name == command_name)
        .map(|c| c.mode);
    let mode = match manifest_mode {
        Some(mode) => mode,
        None => match state.root_commands.host_command_name_for(&extension_id, &command_name) {
            Some(_) => {
                let full_id = crate::application::extension_commands::extension_command_id(&extension_id, &command_name);
                let opens_view = state.root_commands.flags_for(&full_id).map(|(_, opens_view)| opens_view).unwrap_or(false);
                if opens_view { "view".to_string() } else { "no-view".to_string() }
            }
            None => "view".to_string(),
        },
    };
    // A no-view extension command is the extension equivalent of an app or
    // system command: it acts on the previously focused application and has
    // no UI to replace the palette. Hide before launching so actions such as
    // window tiling and mute do not leave the palette covering the screen.
    if mode == "no-view" {
        window::hide_palette(&app).map_err(|e| e.to_string())?;
    }

    crate::application::extension_commands::launch(&app, &extension_id, &command_name, &arguments).await?;
    Ok(mode)
}

/// Tears down a specific mounted command — sent on every view-exit path
/// (back/close) for an extension-command view, since with concurrent
/// mounts (T9) there's no longer a guaranteed *next* `runCommand` call to
/// implicitly clean this one up.
#[tauri::command]
pub async fn unmount_extension_command(state: State<'_, AppState>, extension_id: String, command_name: String) -> Result<(), String> {
    state
        .extension_host
        .notify("extension.unmountCommand", Some(json!({ "extensionId": extension_id, "commandName": command_name })))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn invoke_extension_callback(state: State<'_, AppState>, callback_id: String, args: Vec<Value>) -> Result<(), String> {
    state
        .extension_host
        .notify("extension.invokeCallback", Some(json!({ "callbackId": callback_id, "args": args })))
        .await
        .map_err(|e| e.to_string())
}

/// Pops one level off a mounted command's own navigation stack (what an
/// `Action.Push` put there), returning whether there was anything to pop —
/// `false` means the command is already showing its initial view, and the
/// frontend's back button / Escape should leave the command instead.
#[tauri::command]
pub async fn pop_extension_view(state: State<'_, AppState>, extension_id: String, command_name: String) -> Result<bool, String> {
    let value = state
        .extension_host
        .call(
            "extension.popNavigation",
            Some(json!({ "extensionId": extension_id, "commandName": command_name })),
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(value.as_bool().unwrap_or(false))
}

/// T24: an extension window's own frontend calls this once it's attached
/// its `extension-ui-commit` listener — only then does Node's window
/// mounter actually call `mount()` and start streaming commits, so the
/// very first one (always a full `snapshot`, see `reconciler.ts::mount`)
/// can never be emitted to a window whose page hasn't finished loading yet
/// and would otherwise miss it. Mirrors `NotesWindow`'s own
/// pull-on-mount handoff (`get_active_note`), just push-based: Node is
/// waiting on this rather than Rust holding state for the window to pull.
#[tauri::command]
pub async fn notify_extension_window_ready(state: State<'_, AppState>, window_label: String) -> Result<(), String> {
    state
        .extension_host
        .notify("extension.windowReady", Some(json!({ "windowLabel": window_label })))
        .await
        .map_err(|e| e.to_string())
}

/// Answers a `host.system.confirmAlert` request the palette's confirm
/// dialog is currently showing — see `ConfirmAlertRegistry`'s doc comment.
#[tauri::command]
pub fn resolve_confirm_alert(state: State<'_, AppState>, request_id: String, confirmed: bool) -> Result<(), String> {
    if state.confirm_alerts.resolve(&request_id, confirmed) {
        Ok(())
    } else {
        Err(format!("no pending confirmAlert request '{request_id}'"))
    }
}
