use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

use crate::application::registry_sources::{normalize_url, RegistrySource};
use crate::application::state::AppState;
use crate::application::extensions_registry::ExtensionEntry;
use crate::infrastructure::extension_host::protocol::HostBuildResult;

/// Where cached catalogs live — beside the database, so they're covered by
/// the same app-data lifetime as everything else and are disposable.
fn catalog_cache_dir(app: &AppHandle) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("registry-cache");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

fn extensions_root(app: &AppHandle) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("extensions");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn list_registry_sources(state: State<AppState>) -> Vec<RegistrySource> {
    state.registry_sources.list()
}

/// Adds a registry, but only after its catalog actually reads — a URL that
/// serves nothing usable should never become a stored source the Store then
/// reports errors for forever.
///
/// The caller is expected to have confirmed with the user first: extensions
/// from a registry run as unsigned code with the user's own privileges, so
/// adding one is the trust decision, not installing from it.
#[tauri::command]
pub async fn add_registry_source(app: AppHandle, state: State<'_, AppState>, url: String) -> Result<RegistrySource, String> {
    let catalog = fetch_catalog_value(&app, &state, &url).await?;
    let name = catalog.get("name").and_then(Value::as_str);
    let added_at = crate::infrastructure::time::now_millis();
    state.registry_sources.add(&url, name, added_at).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remove_registry_source(state: State<AppState>, url: String) -> Result<(), String> {
    Ok(state.registry_sources.remove(&url)?)
}

#[tauri::command]
pub fn set_registry_source_enabled(state: State<AppState>, url: String, enabled: bool) -> Result<(), String> {
    Ok(state.registry_sources.set_enabled(&url, enabled)?)
}

#[tauri::command]
pub fn set_registry_source_auto_update(state: State<AppState>, url: String, auto_update: bool) -> Result<(), String> {
    Ok(state.registry_sources.set_auto_update(&url, auto_update)?)
}

async fn fetch_catalog_value(app: &AppHandle, state: &State<'_, AppState>, url: &str) -> Result<Value, String> {
    let cache_dir = catalog_cache_dir(app)?;
    state
        .extension_host
        .call("registry.fetchCatalog", Some(json!({ "url": url, "cacheDir": cache_dir })))
        .await
        .map_err(|e| e.to_string())
}

/// One registry's catalog, as the Store renders it.
#[tauri::command]
pub async fn fetch_registry_catalog(app: AppHandle, state: State<'_, AppState>, url: String) -> Result<Value, String> {
    fetch_catalog_value(&app, &state, &url).await
}

/// What an install would mean for an extension already present under the
/// same id — the Store turns this into a confirmation before it happens.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum InstallImpact {
    /// Nothing installed under this id.
    Fresh,
    /// Same id, same registry: an ordinary update.
    Update { from: Option<String> },
    /// Same id, *different* origin. Installing replaces the other one, and
    /// they share `extension_storage`, so this is never silent.
    Replace { current_source: Option<String> },
    /// A built-in. Refused outright rather than confirmed — built-ins
    /// version with the app.
    Blocked { reason: String },
}

/// Pure so the decision is testable without a database, a registry, or a
/// running host — see this module's tests.
pub fn classify_install(existing: Option<&ExtensionEntry>, source_url: &str) -> InstallImpact {
    let Some(existing) = existing else { return InstallImpact::Fresh };
    if existing.source == "builtin" {
        return InstallImpact::Blocked {
            reason: format!("'{}' is a built-in extension and can't be replaced", existing.id),
        };
    }
    if existing.source == crate::application::dev_extensions::DEV_SOURCE {
        return InstallImpact::Blocked {
            reason: format!("'{}' is being developed locally — stop developing it first", existing.id),
        };
    }
    match existing.source_url.as_deref() {
        Some(current) if normalize_url(current) == normalize_url(source_url) => {
            InstallImpact::Update { from: existing.version.clone() }
        }
        current => InstallImpact::Replace { current_source: current.map(str::to_string) },
    }
}

#[tauri::command]
pub fn classify_registry_install(state: State<AppState>, id: String, source_url: String) -> InstallImpact {
    let extensions = state.extensions.list();
    classify_install(extensions.iter().find(|e| e.id == id), &source_url)
}

/// Downloads, verifies, installs, and records provenance in one step.
///
/// `file_url` and `sha256` come from the catalog the caller just read. The
/// digest is checked inside the host, between download and unpack, so
/// nothing can be substituted in between.
#[tauri::command]
pub async fn install_from_registry(
    app: AppHandle,
    state: State<'_, AppState>,
    source_url: String,
    file_url: String,
    sha256: Option<String>,
) -> Result<ExtensionEntry, String> {
    install_from_registry_inner(&app, &state, &source_url, &file_url, sha256.as_deref()).await
}

pub(crate) async fn install_from_registry_inner(
    app: &AppHandle,
    state: &State<'_, AppState>,
    source_url: &str,
    file_url: &str,
    sha256: Option<&str>,
) -> Result<ExtensionEntry, String> {
    let root = extensions_root(app)?;
    let mut params = json!({ "fileUrl": file_url, "extensionsRoot": root });
    if let Some(sha256) = sha256 {
        params["sha256"] = json!(sha256);
    }
    let value = state
        .extension_host
        .call("registry.install", Some(params))
        .await
        .map_err(|e| e.to_string())?;
    let result: HostBuildResult = serde_json::from_value(value).map_err(|e| e.to_string())?;

    // The archive is on disk by now, but registering it is what makes it
    // *this* extension — so the id-collision rules are enforced here, where
    // the id is finally known, rather than trusting the caller's own
    // pre-flight `classify_registry_install`.
    let extensions = state.extensions.list();
    if let InstallImpact::Blocked { reason } = classify_install(extensions.iter().find(|e| e.id == result.id), source_url) {
        return Err(reason);
    }

    crate::api::extensions::register_installed_extension(app, state, result, "installed", Some(&normalize_url(source_url)))
}
