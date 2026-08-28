use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

use crate::application::dev_extensions;
use crate::application::extensions_registry::{ExtensionEntry, PreferenceDefinition, CLIPBOARD_HISTORY_ID};
use crate::application::state::AppState;
use crate::infrastructure::extension_host::protocol::{CommandMode, HostBuildResult};

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

/// Registers a freshly built extension and returns its settings-facing
/// entry. `source` distinguishes the install paths that land here —
/// `"installed"` for a copy under the app's extensions root, `"dev"` for a
/// folder the author owns and is actively editing (see
/// `application::dev_extensions`) — since everything downstream of
/// registration is identical for both.
fn finish_install(app: &AppHandle, state: &State<AppState>, result: HostBuildResult, source: &str) -> Result<ExtensionEntry, String> {
    register_installed_extension(app, state, result, source, None)
}

/// As [`finish_install`], recording which registry the extension came from
/// (and the version that registry advertised). Only the archive path has
/// either to record. `pub(crate)` under a descriptive name because
/// `api::registry` finishes its own installs through it — the registry path
/// downloads and verifies before it gets here, but everything from
/// registration onward is identical.
pub(crate) fn register_installed_extension(
    app: &AppHandle,
    state: &State<AppState>,
    result: HostBuildResult,
    source: &str,
    source_url: Option<&str>,
) -> Result<ExtensionEntry, String> {
    if !result.build_errors.is_empty() {
        log::warn!("extension '{}' registered with build errors: {:?}", result.id, result.build_errors);
    }

    state.extensions.register_installed_from(
        &result.id,
        &result.manifest,
        &result.dir,
        source,
        result.version.as_deref(),
        source_url,
    )?;

    // Icons are loaded through Tauri's asset protocol, which serves only
    // scoped paths. `tauri.conf.json` covers `$APPDATA/extensions/**`, but
    // an extension being developed lives wherever its author keeps it — so
    // without this every dev extension shows a broken image instead of its
    // icon. Widening the scope to the directory we just registered is the
    // same thing `host.system.allowAssetDirectory` does for an extension
    // that asks; this does it for the extension's own icon, which it never
    // gets a chance to ask about.
    let _ = app.asset_protocol_scope().allow_directory(&result.dir, true);

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
    let result: HostBuildResult = serde_json::from_value(value).map_err(|e| e.to_string())?;
    finish_install(&app, &state, result, "installed")
}

#[tauri::command]
pub async fn install_extension_from_slug(app: AppHandle, state: State<'_, AppState>, slug: String) -> Result<ExtensionEntry, String> {
    let root = extensions_root(&app)?;
    let value = state
        .extension_host
        .call("extension.installStoreSlug", Some(json!({ "slug": slug, "extensionsRoot": root })))
        .await
        .map_err(|e| e.to_string())?;
    let result: HostBuildResult = serde_json::from_value(value).map_err(|e| e.to_string())?;
    finish_install(&app, &state, result, "installed")
}

#[tauri::command]
pub async fn uninstall_extension(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    // Uninstall deletes `<extensionsRoot>/<id>` from disk. A dev extension
    // is registered against the *author's* directory, and nothing stops
    // that directory from being the very path this would delete (an author
    // who points dev mode at a folder they put under the app's extensions
    // root). Refusing here keeps "uninstall" from ever being the command
    // that eats someone's source tree — `remove_dev_extension` is the
    // deliberate, file-touching-free way out.
    if state.extensions.list().iter().any(|e| e.id == id && e.source == dev_extensions::DEV_SOURCE) {
        return Err(format!("'{id}' is being developed locally — remove it from its extension page instead."));
    }

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

/// Installs a prebuilt `.orx` archive: unzip, validate, swap into place.
///
/// The one install path that needs nothing on the user's machine — no git,
/// no npm, no compiler — because the archive already carries built command
/// bundles. `source_url` is recorded when the archive came from a registry,
/// which is what later makes an update check possible; a hand-picked file
/// passes `None` and simply never reports updates.
#[tauri::command]
pub async fn install_extension_from_archive(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    source_url: Option<String>,
) -> Result<ExtensionEntry, String> {
    let root = extensions_root(&app)?;
    let value = state
        .extension_host
        .call("extension.installArchive", Some(json!({ "path": path, "extensionsRoot": root })))
        .await
        .map_err(|e| e.to_string())?;
    let result: HostBuildResult = serde_json::from_value(value).map_err(|e| e.to_string())?;

    // Refusing to let an archive replace a built-in: built-ins version with
    // the app, and a registry that could overwrite one would be able to
    // take over Notes or Clipboard History wholesale.
    if let Some(existing) = state.extensions.list().into_iter().find(|e| e.id == result.id) {
        if existing.source == "builtin" {
            return Err(format!("'{}' is a built-in extension and can't be replaced", result.id));
        }
    }

    register_installed_extension(&app, &state, result, "installed", source_url.as_deref())
}

/// Starts dev mode for an extension directory the author owns: the host
/// builds it **in place** and watches it, and every rebuild arrives back as
/// an `extension.devBuild` notification (see
/// `application::extension_bridge::dispatch_notification`).
///
/// Unlike the install commands above, nothing is copied anywhere — the
/// registered `path` is the author's own folder, which is what makes their
/// editor, their git checkout, and the running app all the same files.
#[tauri::command]
pub async fn develop_extension(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<ExtensionEntry, String> {
    develop_extension_at(&app, &state, &path).await
}

/// The develop flow itself, callable from outside the Tauri command layer —
/// the CLI control socket drives exactly this, so `openray develop` and the
/// Settings picker cannot drift apart.
pub(crate) async fn develop_extension_at(
    app: &AppHandle,
    state: &State<'_, AppState>,
    path: &str,
) -> Result<ExtensionEntry, String> {
    let result = dev_extensions::start(state, path).await?;
    let entry = finish_install(app, state, result, dev_extensions::DEV_SOURCE)?;
    state.dev_extensions.record(&entry.id, path);
    state.sync_hotkey_bindings(app);
    Ok(entry)
}

/// Stops watching, keeping the registration: the extension goes on working
/// from the bundles already built in its folder, it just no longer picks
/// up edits. This is the "I'm done editing for now" exit, distinct from
/// `remove_dev_extension`'s "forget this folder entirely".
#[tauri::command]
pub async fn stop_developing(state: State<'_, AppState>, id: String) -> Result<(), String> {
    dev_extensions::stop(&state, &id).await;
    Ok(())
}

/// Unregisters a dev extension without touching a single file on disk —
/// the directory belongs to the author, not to us. (`uninstall_extension`
/// would delete `<extensionsRoot>/<id>`, which for a dev extension is not
/// even where its code lives.)
#[tauri::command]
pub async fn remove_dev_extension(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    dev_extensions::stop(&state, &id).await;
    state.extensions.unregister(&id)?;
    state.command_settings.delete_for_extension(&id)?;
    state.root_commands.clear_extension(&id);
    state.sync_hotkey_bindings(&app);
    Ok(())
}

/// The directories currently being watched, keyed by extension id — the
/// Settings pane's source of truth for which dev extensions are *live*
/// versus merely registered (a registered dev extension whose watcher
/// isn't running after a restart still appears in `list_extensions` with
/// `source = "dev"`).
#[tauri::command]
pub fn list_dev_extensions(state: State<AppState>) -> Vec<dev_extensions::DevSession> {
    state.dev_extensions.list()
}
