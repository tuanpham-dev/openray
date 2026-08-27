use std::collections::BTreeSet;
use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::application::state::AppState;
use crate::application::transfer::file::FileInfo;
use crate::application::transfer::snapshot::{ExportToggles, ExtensionScope, PasswordPreference};
use crate::application::transfer::{self, ExportSummary, ImportSummary};

/// One row in the Import / Export pane's category list. Built from the
/// registry, so it costs nothing to ask and starts no extensions — the
/// whole reason the declaration lives in the manifest rather than being
/// discovered at runtime.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportCategory {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
}

/// The extensions offering Import/Export right now. A disabled extension
/// is deliberately absent: it contributes no row and no data.
#[tauri::command]
pub fn list_export_categories(state: State<AppState>) -> Vec<ExportCategory> {
    let mut categories: Vec<ExportCategory> = state
        .extensions
        .list()
        .into_iter()
        .filter(|e| e.enabled)
        .filter_map(|e| {
            let declaration = e.export?;
            Some(ExportCategory { id: e.id, title: declaration.title, description: declaration.description })
        })
        .collect();
    categories.sort_by(|a, b| a.title.cmp(&b.title));
    categories
}

fn scope_from(all_extensions: bool, extensions: Vec<String>) -> ExtensionScope {
    if all_extensions {
        ExtensionScope::All
    } else {
        ExtensionScope::Only(extensions.into_iter().collect::<BTreeSet<_>>())
    }
}

/// The saved credentials an export with this scope would carry, so the
/// pane can warn before anything is written. Read-only.
#[tauri::command]
pub fn inspect_export_sensitivity(
    state: State<AppState>,
    all_extensions: bool,
    extensions: Vec<String>,
) -> Result<Vec<PasswordPreference>, String> {
    let scope = scope_from(all_extensions, extensions);
    let conn = state.db.lock().unwrap();
    Ok(transfer::snapshot::password_preferences_in_scope(&conn, &scope).map_err(crate::error::Error::from)?)
}

/// Reads an export file's plaintext header so the Import flow knows
/// whether to prompt for a passphrase before asking the user for
/// anything. Errors for a file that isn't an OpenRay export at all.
#[tauri::command]
pub fn inspect_export_file(path: String) -> Result<FileInfo, String> {
    Ok(transfer::file::inspect(&PathBuf::from(path))?)
}

/// Writes the selected categories to `path`. `passphrase` is `None` when
/// the user chose to export without encryption; it is never logged or
/// persisted either way. `include_password_preferences` carries the
/// answer to the credential warning.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn export_data(
    app: AppHandle,
    path: String,
    passphrase: Option<String>,
    core: bool,
    all_extensions: bool,
    extensions: Vec<String>,
    clipboard: bool,
    usage: bool,
    include_password_preferences: bool,
) -> Result<ExportSummary, String> {
    let toggles =
        ExportToggles { core, extensions: scope_from(all_extensions, extensions), clipboard, usage };
    let conn = app.state::<AppState>().db.clone();
    Ok(transfer::export_to_file(
        &app,
        &conn,
        &PathBuf::from(path),
        passphrase.as_deref(),
        toggles,
        include_password_preferences,
    )
    .await?)
}

/// Merges an export file into this machine's data. `passphrase` is `None`
/// for an unencrypted file; a wrong one comes back as an error the
/// frontend shows in the still-open prompt.
#[tauri::command]
pub async fn import_data(app: AppHandle, path: String, passphrase: Option<String>) -> Result<ImportSummary, String> {
    let conn = app.state::<AppState>().db.clone();
    Ok(transfer::import_from_file(&app, &conn, &PathBuf::from(path), passphrase.as_deref()).await?)
}
