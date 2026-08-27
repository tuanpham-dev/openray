use std::collections::{HashMap, HashSet};

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::application::state::AppState;
use crate::application::{frecency, search as search_use_case};
use crate::domain::command::Command;
use crate::infrastructure::time::now_secs as now_unix;
use crate::infrastructure::window;

/// A command plus the per-command settings the palette renders alongside it.
/// Kept as a response DTO rather than a field on `domain::command::Command`
/// so providers (which construct `Command` in a dozen places and know
/// nothing about user-assigned aliases) stay untouched. `needs_confirm`
/// (T14) is the same story one layer further: only a `root-provider`-
/// contributed row ever sets it, via `RootCommandProvider`'s side-table,
/// never a `Command` field — `App.tsx`'s static `needsConfirmation` id
/// list handles every other confirm-needing id, this is its per-row,
/// dynamic-id counterpart.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchCommand {
    #[serde(flatten)]
    pub command: Command,
    pub alias: Option<String>,
    pub needs_confirm: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub commands: Vec<SearchCommand>,
}

#[tauri::command]
pub fn search(app: AppHandle, state: State<AppState>, query: String) -> Result<SearchResponse, String> {
    // Perf-baseline instrumentation (plans/refactor-extension-platform.md,
    // T33/T34) — an ongoing latency signal on the hot search path. `info`,
    // not `debug`: tauri_plugin_log's level filter below is hardcoded to
    // `LevelFilter::Info`, so a `debug!` here would be silently dropped
    // regardless of RUST_LOG.
    let started_at = std::time::Instant::now();
    // T21: fired off *after* the synchronous work below, not before —
    // `dispatch` only spawns a background task and returns immediately,
    // but starting it first would still cost this call a `try_state`
    // lookup + `Vec` clone on every keystroke ahead of the timed section,
    // which is exactly the regression the T33 baseline exists to catch.
    let result = search_inner(state, query.clone());
    log::info!("search: {}us", started_at.elapsed().as_micros());
    crate::application::inline_query::dispatch(&app, query);
    result
}

fn search_inner(state: State<AppState>, query: String) -> Result<SearchResponse, String> {
    let commands = state.registry.all_commands();

    let usage = state.usage.all_usage().map_err(|e| e.to_string())?;
    let now = now_unix();

    let frecency_scores: HashMap<String, f64> = usage
        .into_iter()
        .map(|(id, (hits, last_used_at))| (id, frecency::frecency_score(hits, last_used_at, now)))
        .collect();

    let command_settings = state.command_settings.all();
    let aliases: HashMap<String, String> =
        command_settings.iter().filter_map(|(id, entry)| entry.alias.clone().map(|alias| (id.clone(), alias))).collect();
    let disabled: HashSet<String> =
        command_settings.iter().filter(|(_, entry)| !entry.enabled).map(|(id, _)| id.clone()).collect();

    let sensitivity = state.settings.get().search_sensitivity;
    let ranked = search_use_case::search(&commands, &query, &frecency_scores, &aliases, &disabled, &sensitivity);

    Ok(SearchResponse {
        commands: ranked
            .into_iter()
            .map(|command| {
                let needs_confirm = state.root_commands.flags_for(&command.id).map(|(needs_confirm, _)| needs_confirm).unwrap_or(false);
                SearchCommand { alias: aliases.get(&command.id).cloned(), needs_confirm, command }
            })
            .collect(),
    })
}

#[tauri::command]
pub fn run_command(app: AppHandle, state: State<AppState>, id: String) -> Result<(), String> {
    // Hide first — see the comment in api/clipboard.rs::paste_clipboard_entry.
    // Snippet execution injects a paste keystroke that must land on the
    // previously-focused app, not on the still-visible palette window.
    window::hide_palette(&app).map_err(|e| e.to_string())?;
    state.registry.execute(&id)?;
    state.usage.record_usage(&id, now_unix()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn run_command_with_argument(
    app: AppHandle,
    state: State<AppState>,
    id: String,
    argument: String,
) -> Result<(), String> {
    window::hide_palette(&app).map_err(|e| e.to_string())?;
    state.registry.execute_with_argument(&id, &argument)?;
    state.usage.record_usage(&id, now_unix()).map_err(|e| e.to_string())
}
