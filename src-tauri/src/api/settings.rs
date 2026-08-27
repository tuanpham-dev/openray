use std::collections::HashMap;

use tauri::{AppHandle, State};
use tauri_plugin_autostart::ManagerExt;

use crate::application::command_settings::CommandSettingsEntry;
use crate::application::state::AppState;
use crate::domain::command::Command;
use crate::infrastructure::settings::Settings;
use crate::infrastructure::window;

#[tauri::command]
pub fn get_settings(state: State<AppState>) -> Settings {
    state.settings.get()
}

#[tauri::command]
pub fn update_settings(app: AppHandle, state: State<AppState>, settings: Settings) -> Result<(), String> {
    let autolaunch = app.autolaunch();
    if settings.launch_at_login {
        autolaunch.enable().map_err(|e| e.to_string())?;
    } else {
        autolaunch.disable().map_err(|e| e.to_string())?;
    }

    // Clamping itself now happens inside `SettingsStore::update` so every
    // writer is covered, not just this command — see its doc comment.
    // T26: `notes_always_on_top` used to be live-applied to the native
    // notes window here (`window::set_notes_always_on_top`) — the
    // extension reads it fresh on its own next window open instead
    // (`host.notes.getSettings`, not live-applied to an already-open
    // window, a disclosed simplification — see that bridge method's doc
    // comment in `extension_bridge.rs`).
    let previous = state.settings.get();
    let previous_scopes = previous.screenshot_search_scopes;
    let previous_file_search_scopes = previous.file_search_scopes;
    let show_tray_icon_changed = previous.show_tray_icon != settings.show_tray_icon;
    let show_tray_icon = settings.show_tray_icon;
    state.settings.update(settings)?;

    if show_tray_icon_changed {
        if let Some(tray) = app.tray_by_id(crate::infrastructure::tray::TRAY_ID) {
            let _ = tray.set_visible(show_tray_icon);
        }
    }

    // T29: unlike native `CommandProvider::commands()` (called fresh on
    // every search keystroke), a `root-provider` extension's rows are
    // push-based — `screenshots`' own "no scopes → no rows" check in its
    // `list.ts` only re-runs when *something* asks it to, and nothing
    // native did that for a Settings-pane scopes edit. Found live: rows
    // stayed visible after clearing every scope, and stayed hidden after
    // adding one back, until the app was restarted. Fixed by detecting
    // the specific field that gates row visibility and re-triggering that
    // one extension's listing directly — same shape as
    // `set_extension_enabled`'s clipboard-watcher special-case, not a
    // blanket refresh of every root-provider on every settings save.
    if state.settings.get().screenshot_search_scopes != previous_scopes {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = crate::application::extension_commands::launch_root_provider_listing(&app, "screenshots", "list").await {
                log::warn!("failed to refresh screenshots root-provider listing after a scopes change: {e}");
            }
        });
    }

    // Same "no scopes → no rows" push-based gating as Screenshots above —
    // File Search's `list.tsx` re-checks `fileSearchScopes.length === 0`
    // only when asked, so a Settings-pane scopes edit needs the identical
    // re-trigger or the "Search Files" row stays hidden/stale until the
    // app restarts.
    if state.settings.get().file_search_scopes != previous_file_search_scopes {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = crate::application::extension_commands::launch_root_provider_listing(&app, "file-search", "list").await {
                log::warn!("failed to refresh file-search root-provider listing after a scopes change: {e}");
            }
        });
    }

    Ok(())
}

/// Whichever binding — the palette toggle or another command — already owns
/// `hotkey`, as a human-readable name for the conflict error. Takes plain
/// data rather than `&AppState` so it's testable without a Tauri runtime.
/// `exclude_command_id` skips a command's own row so re-saving its current
/// value isn't reported as a conflict with itself.
fn find_hotkey_conflict(
    palette_hotkey: &str,
    commands: &[Command],
    command_settings: &HashMap<String, CommandSettingsEntry>,
    hotkey: &str,
    exclude_command_id: Option<&str>,
) -> Option<String> {
    if palette_hotkey == hotkey {
        return Some("the palette hotkey".to_string());
    }

    command_settings.iter().find_map(|(id, entry)| {
        if entry.hotkey.as_deref() != Some(hotkey) {
            return None;
        }
        if Some(id.as_str()) == exclude_command_id {
            return None;
        }
        Some(commands.iter().find(|c| &c.id == id).map(|c| c.title.clone()).unwrap_or_else(|| id.clone()))
    })
}

#[tauri::command]
pub fn update_hotkey(app: AppHandle, state: State<AppState>, hotkey: String) -> Result<(), String> {
    let mut current = state.settings.get();
    if hotkey != current.hotkey {
        let conflict = find_hotkey_conflict(&current.hotkey, &state.registry.all_commands(), &state.command_settings.all(), &hotkey, None);
        if let Some(owner) = conflict {
            return Err(format!("Already used by {owner}"));
        }
    }

    current.hotkey = hotkey;
    state.settings.update(current)?;
    state.sync_hotkey_bindings(&app);
    Ok(())
}

#[tauri::command]
pub fn open_settings(app: AppHandle) -> Result<(), String> {
    window::open_settings_window(&app).map_err(|e| e.to_string())
}

/// Every command in the registry (apps, builtins, quicklinks, snippets,
/// extension commands) — the settings window's source list for grouping
/// into its Applications / per-extension / Built-ins table.
#[tauri::command]
pub fn list_settings_commands(state: State<AppState>) -> Vec<Command> {
    state.registry.all_commands()
}

#[tauri::command]
pub fn list_command_settings(state: State<AppState>) -> HashMap<String, CommandSettingsEntry> {
    state.command_settings.all()
}

#[tauri::command]
pub fn set_command_hotkey(app: AppHandle, state: State<AppState>, command_id: String, hotkey: Option<String>) -> Result<(), String> {
    if let Some(ref value) = hotkey {
        if !value.is_empty() {
            let palette_hotkey = state.settings.get().hotkey;
            let conflict = find_hotkey_conflict(
                &palette_hotkey,
                &state.registry.all_commands(),
                &state.command_settings.all(),
                value,
                Some(&command_id),
            );
            if let Some(owner) = conflict {
                return Err(format!("Already used by {owner}"));
            }
        }
    }

    state.command_settings.set_hotkey(&command_id, hotkey.as_deref())?;
    state.sync_hotkey_bindings(&app);
    Ok(())
}

#[tauri::command]
pub fn set_command_alias(state: State<AppState>, command_id: String, alias: Option<String>) -> Result<(), String> {
    state.command_settings.set_alias(&command_id, alias.as_deref())
}

#[tauri::command]
pub fn set_command_enabled(app: AppHandle, state: State<AppState>, command_id: String, enabled: bool) -> Result<(), String> {
    state.command_settings.set_enabled(&command_id, enabled)?;
    state.sync_hotkey_bindings(&app);
    Ok(())
}

/// T22: the translate extension keys its history entries `history:{id}`
/// (alongside its custom pairs, `pair:{id}`, in the same
/// `extension_storage` bucket) — clearing only that prefix, not the whole
/// extension's storage, is what the Settings → Translate "Clear History"
/// button needs. Lives here (not a translate-specific api module, deleted
/// this task) since it's a Settings-pane action, not something the
/// running extension itself ever calls.
#[tauri::command]
pub fn clear_translate_history(state: State<AppState>) -> Result<(), String> {
    state.extension_storage.clear_matching("translate", "history:")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::command::CommandKind;

    fn command(id: &str, title: &str) -> Command {
        Command {
            id: id.into(),
            title: title.into(),
            subtitle: None,
            icon: None,
            kind: CommandKind::App,
            keywords: vec![],
            requires_argument: false,
        }
    }

    fn entry(hotkey: &str) -> CommandSettingsEntry {
        CommandSettingsEntry { alias: None, hotkey: Some(hotkey.to_string()), enabled: true }
    }

    #[test]
    fn detects_palette_hotkey_conflict() {
        let conflict = find_hotkey_conflict("Alt+Space", &[], &HashMap::new(), "Alt+Space", None);
        assert_eq!(conflict, Some("the palette hotkey".to_string()));
    }

    #[test]
    fn detects_another_commands_hotkey() {
        let commands = vec![command("firefox.desktop", "Firefox")];
        let mut settings = HashMap::new();
        settings.insert("firefox.desktop".to_string(), entry("Ctrl+Alt+KeyF"));

        let conflict = find_hotkey_conflict("Alt+Space", &commands, &settings, "Ctrl+Alt+KeyF", None);
        assert_eq!(conflict, Some("Firefox".to_string()));
    }

    #[test]
    fn excludes_the_commands_own_row() {
        let commands = vec![command("firefox.desktop", "Firefox")];
        let mut settings = HashMap::new();
        settings.insert("firefox.desktop".to_string(), entry("Ctrl+Alt+KeyF"));

        let conflict = find_hotkey_conflict("Alt+Space", &commands, &settings, "Ctrl+Alt+KeyF", Some("firefox.desktop"));
        assert_eq!(conflict, None);
    }

    #[test]
    fn none_when_hotkey_is_free() {
        assert_eq!(find_hotkey_conflict("Alt+Space", &[], &HashMap::new(), "Ctrl+Alt+KeyZ", None), None);
    }

    #[test]
    fn falls_back_to_id_when_owning_command_has_no_title_match() {
        let mut settings = HashMap::new();
        settings.insert("ghost.desktop".to_string(), entry("Ctrl+Alt+KeyG"));

        let conflict = find_hotkey_conflict("Alt+Space", &[], &settings, "Ctrl+Alt+KeyG", None);
        assert_eq!(conflict, Some("ghost.desktop".to_string()));
    }
}
