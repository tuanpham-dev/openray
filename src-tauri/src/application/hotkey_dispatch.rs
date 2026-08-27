use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::application::state::AppState;
use crate::domain::command::{Command, CommandKind};
use crate::infrastructure::time::now_secs as now_unix;
use crate::infrastructure::window;

/// The `hotkey-command` event payload — `Command` plus the one extra flag
/// the frontend's confirm gate needs (`PaletteItem.needsConfirm`; see
/// `api/search.rs::SearchCommand`, which threads the same flag through the
/// ordinary search response the same way). Without this, a hotkey bound to
/// a root-provider row that `classify()` correctly routed to `Launch::View`
/// would still land back on the plain palette instead of the confirm
/// surface — `needsConfirm` never reached the frontend at all.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HotkeyCommand {
    #[serde(flatten)]
    command: Command,
    needs_confirm: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Launch {
    /// Runs immediately via `CommandRegistry::execute`; the palette is
    /// never shown.
    Headless,
    /// Needs the palette open to render (a view/menu-bar extension
    /// command, a form, an argument prompt); the frontend takes over from
    /// there via the `hotkey-command` event.
    View,
}

use crate::application::extension_commands::parse_extension_command_id;

/// Pure classification, independent of the DB lookup needed to find an
/// extension command's declared mode — callers resolve `extension_mode`
/// once (see `run`) and pass it in. `root_provider_flags` is the T14
/// dynamic-row equivalent of the old `VIEW_BUILTIN_IDS`/`CONFIRM_COMMAND_IDS`
/// constants (T29 deleted `VIEW_BUILTIN_IDS` outright — it held only
/// screenshots' entry, and every native command it once needed to name has
/// since become either an `ExtensionCommand` with `mode: "view"`, already
/// covered below, or a root-provider row, covered here) —
/// `Some((needs_confirm, opens_view))` when `command.id` names a
/// currently-known root-provider-contributed row, `None` otherwise (a
/// static command, or a row from an extension whose listing hasn't
/// pushed yet — falls through to ordinary classification either way).
fn classify(command: &Command, extension_mode: Option<&str>, root_provider_flags: Option<(bool, bool)>) -> Launch {
    if command.requires_argument {
        return Launch::View;
    }
    if let Some((needs_confirm, opens_view)) = root_provider_flags {
        if needs_confirm || opens_view {
            return Launch::View;
        }
    }
    if command.kind == CommandKind::ExtensionCommand {
        return match extension_mode {
            Some("view") | Some("menu-bar") => Launch::View,
            _ => Launch::Headless,
        };
    }
    Launch::Headless
}

/// Runs the command a global hotkey was bound to. Headless commands
/// (apps, snippets, no-view extension commands, …) execute directly with
/// no palette flash; commands that need a UI surface show the palette and
/// hand off to the frontend via the `hotkey-command` event, which routes
/// through the same navigation `onActivate` uses for a normal click.
pub fn run(app: &AppHandle, command_id: &str) {
    let Some(state) = app.try_state::<AppState>() else { return };

    let Some(command) = state.registry.all_commands().into_iter().find(|c| c.id == command_id) else {
        log::warn!("hotkey fired for unknown command '{command_id}'");
        return;
    };

    let extension_mode = if command.kind == CommandKind::ExtensionCommand {
        parse_extension_command_id(&command.id).and_then(|(extension_id, name)| {
            state
                .extensions
                .installed_commands()
                .into_iter()
                .find(|c| c.extension_id == extension_id && c.name == name)
                .map(|c| c.mode)
        })
    } else {
        None
    };
    let root_provider_flags = state.root_commands.flags_for(&command.id);

    if classify(&command, extension_mode.as_deref(), root_provider_flags) == Launch::View {
        if let Err(e) = window::show_palette(app) {
            log::warn!("failed to show palette for hotkey command '{command_id}': {e}");
            return;
        }
        let needs_confirm = root_provider_flags.map(|(needs_confirm, _)| needs_confirm).unwrap_or(false);
        let _ = app.emit("hotkey-command", &HotkeyCommand { command, needs_confirm });
        return;
    }

    if let Err(e) = state.registry.execute(command_id) {
        log::warn!("hotkey command '{command_id}' failed: {e}");
        return;
    }
    let _ = state.usage.record_usage(command_id, now_unix());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command(id: &str, kind: CommandKind, requires_argument: bool) -> Command {
        Command {
            id: id.to_string(),
            title: "Title".into(),
            subtitle: None,
            icon: None,
            kind,
            keywords: vec![],
            requires_argument,
        }
    }

    #[test]
    fn hotkey_command_payload_flattens_needs_confirm_alongside_command_fields() {
        let cmd = command("ext:system-commands:empty-trash", CommandKind::ExtensionCommand, false);
        let payload = HotkeyCommand { command: cmd, needs_confirm: true };
        let json = serde_json::to_value(&payload).expect("HotkeyCommand serializes");
        assert_eq!(json["id"], "ext:system-commands:empty-trash");
        assert_eq!(json["needsConfirm"], true);
    }

    #[test]
    fn app_launch_is_headless() {
        let cmd = command("firefox.desktop", CommandKind::App, false);
        assert_eq!(classify(&cmd, None, None), Launch::Headless);
    }

    #[test]
    fn no_view_extension_command_is_headless() {
        let cmd = command("ext:demo:quick-action", CommandKind::ExtensionCommand, false);
        assert_eq!(classify(&cmd, Some("no-view"), None), Launch::Headless);
    }

    #[test]
    fn view_extension_command_is_view() {
        let cmd = command("ext:demo:search", CommandKind::ExtensionCommand, false);
        assert_eq!(classify(&cmd, Some("view"), None), Launch::View);
    }

    #[test]
    fn menu_bar_extension_command_is_view() {
        let cmd = command("ext:demo:menu", CommandKind::ExtensionCommand, false);
        assert_eq!(classify(&cmd, Some("menu-bar"), None), Launch::View);
    }

    #[test]
    fn a_command_requiring_an_argument_is_view_regardless_of_kind() {
        let cmd = command("ext:quicklinks:search-github", CommandKind::ExtensionCommand, true);
        assert_eq!(classify(&cmd, None, None), Launch::View);
    }

    #[test]
    fn a_command_with_no_argument_and_no_other_view_signal_is_headless() {
        let cmd = command("ext:quicklinks:open-docs", CommandKind::ExtensionCommand, false);
        assert_eq!(classify(&cmd, None, None), Launch::Headless);
    }

    #[test]
    fn parses_extension_command_id() {
        assert_eq!(parse_extension_command_id("ext:demo:search"), Some(("demo", "search")));
        assert_eq!(parse_extension_command_id("ext:demo:sub:search"), Some(("demo:sub", "search")));
        assert_eq!(parse_extension_command_id("firefox.desktop"), None);
    }

    #[test]
    fn root_provider_row_needing_confirm_is_view_despite_a_no_view_host_mode() {
        let cmd = command("ext:system:shut-down", CommandKind::ExtensionCommand, false);
        assert_eq!(classify(&cmd, Some("no-view"), Some((true, false))), Launch::View);
    }

    #[test]
    fn root_provider_row_opening_a_view_is_view() {
        let cmd = command("ext:quicklinks:abc123", CommandKind::ExtensionCommand, false);
        assert_eq!(classify(&cmd, Some("no-view"), Some((false, true))), Launch::View);
    }

    #[test]
    fn root_provider_row_with_neither_flag_falls_through_to_extension_mode() {
        let cmd = command("ext:quicklinks:abc123", CommandKind::ExtensionCommand, false);
        assert_eq!(classify(&cmd, Some("no-view"), Some((false, false))), Launch::Headless);
    }

    #[test]
    fn unknown_root_provider_row_falls_through_unaffected() {
        let cmd = command("ext:quicklinks:abc123", CommandKind::ExtensionCommand, false);
        assert_eq!(classify(&cmd, Some("no-view"), None), Launch::Headless);
    }
}
