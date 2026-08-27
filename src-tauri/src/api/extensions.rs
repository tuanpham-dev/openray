use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

use crate::application::extensions_registry::{ExtensionEntry, PreferenceDefinition, CLIPBOARD_HISTORY_ID};
use crate::application::state::AppState;
use crate::infrastructure::extension_host::protocol::{CommandMode, ExtensionManifest};

#[tauri::command]
pub fn list_extensions(state: State<AppState>) -> Vec<ExtensionEntry> {
    state.extensions.list()
}

#[tauri::command]
pub fn set_extension_enabled(app: AppHandle, state: State<AppState>, id: String, enabled: bool) -> Result<(), String> {
    state.extensions.set_enabled(&id, enabled)?;

    if id == CLIPBOARD_HISTORY_ID {
        state.clipboard_watcher.set_enabled(enabled);
    }

    // Static commands are re-filtered for free on the next registry read
    // (`installed_commands`'s `enabled=1` SQL clause), but a root-provider
    // extension's contributed rows live in `RootCommandProvider`'s own
    // in-memory map, which that SQL filter never touches. Two gaps follow,
    // symmetric with `finish_install`'s install-time fix: disabling left
    // stale rows fully visible (and clickable) until restart, and
    // re-enabling left the extension row-less until restart, since nothing
    // re-triggers its listing either. `state.extensions.set_enabled` above
    // already ran, so `installed_commands()` reflects the new state by the
    // time either branch below reads it.
    if enabled {
        if let Some(command) =
            state.extensions.installed_commands().into_iter().find(|c| c.extension_id == id && c.mode == "root-provider")
        {
            let app = app.clone();
            let extension_id = id.clone();
            let command_name = command.name;
            tauri::async_runtime::spawn(async move {
                if let Err(e) = crate::application::extension_commands::launch_root_provider_listing(&app, &extension_id, &command_name).await {
                    log::warn!("failed to refresh '{extension_id}' root-provider listing after enable: {e}");
                }
            });
        }
    } else {
        state.root_commands.clear_extension(&id);
    }

    state.sync_hotkey_bindings(&app);
    Ok(())
}

fn extensions_root(app: &AppHandle) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("extensions");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallResult {
    id: String,
    manifest: ExtensionManifest,
    dir: String,
    #[serde(default)]
    build_errors: Vec<String>,
}

fn finish_install(app: &AppHandle, state: &State<AppState>, result: InstallResult) -> Result<ExtensionEntry, String> {
    if !result.build_errors.is_empty() {
        log::warn!("extension '{}' installed with build errors: {:?}", result.id, result.build_errors);
    }

    state.extensions.register_installed(&result.id, &result.manifest, &result.dir, "installed")?;

    // Root-provider rows are push-based (see `application::root_commands`'s
    // doc comment): they populate at extension-host startup, or when the
    // extension itself calls `refreshRootCommands()` — neither of which a
    // fresh install/update while the app is already running hits. Without
    // this, a newly (re)installed root-provider extension's rows silently
    // don't show up in root search until the app restarts. Same fix shape
    // as `api::settings::update_settings`'s scopes-changed re-trigger, for
    // the install path instead of a settings-change path. Spawned *after*
    // `register_installed` above — `launch_root_provider_listing` looks the
    // extension up by id in that same registry, so it must already be
    // written before this task can find it.
    if let Some(command) = result.manifest.commands.iter().find(|c| c.mode == CommandMode::RootProvider) {
        let app = app.clone();
        let extension_id = result.id.clone();
        let command_name = command.name.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = crate::application::extension_commands::launch_root_provider_listing(&app, &extension_id, &command_name).await {
                log::warn!("failed to refresh '{extension_id}' root-provider listing after install: {e}");
            }
        });
    }

    state
        .extensions
        .list()
        .into_iter()
        .find(|e| e.id == result.id)
        .ok_or_else(|| "extension registered but not found after install".to_string())
}

#[tauri::command]
pub async fn install_extension_from_path(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<ExtensionEntry, String> {
    let root = extensions_root(&app)?;
    let value = state
        .extension_host
        .call("extension.installLocal", Some(json!({ "path": path, "extensionsRoot": root })))
        .await
        .map_err(|e| e.to_string())?;
    let result: InstallResult = serde_json::from_value(value).map_err(|e| e.to_string())?;
    finish_install(&app, &state, result)
}

#[tauri::command]
pub async fn install_extension_from_slug(app: AppHandle, state: State<'_, AppState>, slug: String) -> Result<ExtensionEntry, String> {
    let root = extensions_root(&app)?;
    let value = state
        .extension_host
        .call("extension.installStoreSlug", Some(json!({ "slug": slug, "extensionsRoot": root })))
        .await
        .map_err(|e| e.to_string())?;
    let result: InstallResult = serde_json::from_value(value).map_err(|e| e.to_string())?;
    finish_install(&app, &state, result)
}

#[tauri::command]
pub async fn uninstall_extension(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    let root = extensions_root(&app)?;
    state
        .extension_host
        .call("extension.uninstall", Some(json!({ "id": id, "extensionsRoot": root })))
        .await
        .map_err(|e| e.to_string())?;
    state.extensions.unregister(&id)?;
    state.command_settings.delete_for_extension(&id)?;
    state.sync_hotkey_bindings(&app);
    Ok(())
}

#[tauri::command]
pub fn extension_preference_definitions(state: State<AppState>, id: String) -> Vec<PreferenceDefinition> {
    state.extensions.preference_definitions(&id)
}

#[tauri::command]
pub fn extension_preference_values(state: State<AppState>, id: String) -> std::collections::HashMap<String, Value> {
    state.extensions.preference_values(&id)
}

#[tauri::command]
pub fn set_extension_preference_value(state: State<AppState>, id: String, name: String, value: Value) -> Result<(), String> {
    Ok(state.extensions.set_preference_value(&id, &name, &value)?)
}
