use std::collections::HashMap;
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, RwLock};

use tauri::{App, AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

#[cfg(target_os = "linux")]
use crate::infrastructure::session_env::is_wayland;
use crate::application::command_settings::CommandSettingsEntry;
use crate::domain::command::Command;
use crate::infrastructure::window;

/// Fired when no working global hotkey could be set up (already bound by
/// the desktop/another app, portal unavailable, etc.) so the frontend can
/// tell the user rather than leave them wondering why the hotkey does
/// nothing. Shared across the X11/macOS/Windows registration-failure path
/// and Wayland's portal-failure path (see `wayland_hotkey`).
pub const HOTKEY_UNAVAILABLE_EVENT: &str = "hotkey-unavailable";

/// What a bound global shortcut should do when it fires.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HotkeyAction {
    TogglePalette,
    RunCommand(String),
}

/// Serializes every call into `tauri-plugin-global-shortcut`'s
/// register/unregister. `sync_bindings` takes it before touching the plugin,
/// on a spawned thread, never on the caller's own thread. Two things go wrong
/// otherwise, both verified with
/// gdb on a genuinely hung app:
///
/// 1. `register`/`unregister` marshal the actual work onto the main event
///    loop thread and block waiting for it to finish. Called from a
///    thread that's *already* inside that marshaling, the main thread wait
///    can never be satisfied by itself — permanent deadlock, palette never
///    maps.
/// 2. Even off the main thread, two *overlapping* calls (a settings
///    settings changes) can hang the app: the plugin has no
///    concurrency guard of its own, so a second call while the first is
///    still marshaling can leave one of them waiting on a reply that
///    never arrives. This lock is the fix — every caller queues, one
///    call touches the plugin at a time.
static HOTKEY_PLUGIN_LOCK: Mutex<()> = Mutex::new(());

/// The single source of truth for "what does this shortcut currently do",
/// consulted by the plugin's handler on every keypress (X11/macOS/Windows).
/// Keyed by the parsed `Shortcut` itself (not its source string) — `Shortcut`
/// is `Copy + Eq + Hash`, so this sidesteps any question of whether two
/// differently-formatted strings ("Ctrl+Alt+KeyR" vs a re-serialized form)
/// round-trip identically; the plugin handler already hands us a `&Shortcut`
/// to look up directly.
pub struct HotkeyBindings {
    bindings: RwLock<HashMap<Shortcut, HotkeyAction>>,
    /// Whether `tauri-plugin-global-shortcut` initialized successfully.
    /// `sync_bindings` must not touch `app.global_shortcut()` when this is
    /// false — that state simply isn't managed, and would panic.
    plugin_ready: AtomicBool,
}

impl HotkeyBindings {
    pub fn new() -> Self {
        Self { bindings: RwLock::new(HashMap::new()), plugin_ready: AtomicBool::new(false) }
    }

    fn lookup(&self, shortcut: &Shortcut) -> Option<HotkeyAction> {
        self.bindings.read().unwrap().get(shortcut).cloned()
    }

    fn snapshot(&self) -> HashMap<Shortcut, HotkeyAction> {
        self.bindings.read().unwrap().clone()
    }

    fn replace(&self, next: HashMap<Shortcut, HotkeyAction>) {
        *self.bindings.write().unwrap() = next;
    }
}

impl Default for HotkeyBindings {
    fn default() -> Self {
        Self::new()
    }
}

/// A shortcut this app wants bound, independent of which registration
/// mechanism ends up carrying it (the plugin vs. the Wayland portal).
pub struct DesiredBinding {
    pub hotkey: String,
    pub action: HotkeyAction,
    pub description: String,
}

/// Pure function: given the palette hotkey, per-command settings, and the
/// live command list, produces every shortcut that should be bound. A
/// command is included only when it has a non-empty hotkey, is enabled, and
/// still exists in the registry (uninstalled apps / disabled extensions
/// drop out here automatically since they're simply absent from `commands`).
pub fn build_desired_bindings(
    palette_hotkey: &str,
    command_settings: &HashMap<String, crate::application::command_settings::CommandSettingsEntry>,
    commands: &[Command],
) -> Vec<DesiredBinding> {
    let mut desired = vec![DesiredBinding {
        hotkey: palette_hotkey.to_string(),
        action: HotkeyAction::TogglePalette,
        description: "Show/hide OpenRay".to_string(),
    }];

    for command in commands {
        let Some(entry) = command_settings.get(&command.id) else { continue };
        if !entry.enabled {
            continue;
        }
        let Some(hotkey) = entry.hotkey.as_deref().filter(|h| !h.is_empty()) else { continue };
        desired.push(DesiredBinding {
            hotkey: hotkey.to_string(),
            action: HotkeyAction::RunCommand(command.id.clone()),
            description: command.title.clone(),
        });
    }

    desired
}

/// Runs the action a fired hotkey maps to. Must never be called inline
/// from `tauri-plugin-global-shortcut`'s handler — see `init`'s spawn.
///
/// The handler closure passed to `.with_handler()` is not marshalled to
/// the main thread by the plugin; `global_hotkey::GlobalHotKeyEvent::send`
/// (in the `global-hotkey` crate `tauri-plugin-global-shortcut` wraps)
/// calls the registered event handler *directly, synchronously, on
/// whatever thread detected the keypress* — on Linux/X11, that's
/// `global-hotkey`'s own dedicated event-polling thread, the same thread
/// `GlobalHotKeyManager::register`/`unregister` message to and block
/// waiting for an ack from (see `HOTKEY_PLUGIN_LOCK`'s doc comment).
///
/// `dispatch` reaches Tauri window getters — `window.is_visible()` via
/// `toggle_palette`, `window.current_monitor()`/`outer_size()` via
/// `show_palette`'s `center_on_cursor_monitor` — that block the calling
/// thread on a reply from the *main* thread's event loop
/// (`tauri-runtime-wry`'s `getter!` macro: send a message, then
/// `rx.recv()`). Calling `dispatch` inline from the X11 event thread was
/// therefore a real, gdb-verified deadlock: main thread parked in
/// `crossbeam_channel::recv` inside `GlobalHotKeyManager::register`/
/// `unregister` (called from a `sync_bindings` worker thread, itself waiting
/// on that main-thread call) while the
/// *same* X11 event thread — mid-delivery of a concurrent keypress via
/// this handler — sat blocked waiting for that same wedged main thread to
/// service `is_visible()`'s reply. Both sides of the cycle wait on each
/// other; nothing ever unblocks. This reproduced as "palette doesn't
/// reopen on Alt+Space right after a paste" — `hide_palette` (before
/// paste injection) unregisters the Escape grab, and a fast re-press of
/// Alt+Space landed in exactly this window.
///
/// Spawning a plain thread (not `run_on_main_thread`) preserves today's
/// behavior of running command execution off the main GTK loop — a slow
/// headless command (app launch, snippet, extension call) blocking the
/// main thread here would freeze the whole UI, which `run_on_main_thread`
/// would have reintroduced.
fn dispatch(app: &AppHandle, action: HotkeyAction) {
    match action {
        HotkeyAction::TogglePalette => {
            let _ = window::toggle_palette(app);
        }
        HotkeyAction::RunCommand(command_id) => {
            crate::application::hotkey_dispatch::run(app, &command_id);
        }
    }
}

/// Installs the global-shortcut plugin (X11/macOS/Windows only — Wayland
/// has no client-side key-grab to install this against, see
/// `wayland_hotkey`'s module doc) with a handler that looks up
/// `HotkeyBindings` on every keypress. Must run after `HotkeyBindings` is
/// managed. Never fatal: a failed plugin init just means no hotkeys will be
/// available on this run, surfaced via `HOTKEY_UNAVAILABLE_EVENT`.
pub fn init(app: &App) {
    #[cfg(target_os = "linux")]
    if is_wayland() {
        return;
    }

    let handle = app.handle();

    if let Err(e) = handle.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(|app, shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    if let Some(action) = app.state::<HotkeyBindings>().lookup(shortcut) {
                        // Never call `dispatch` inline here — see its doc
                        // comment for the gdb-verified deadlock this
                        // avoids. Spawning is enough (not a marshal to a
                        // specific thread): the point is only that this
                        // callback — which runs synchronously on
                        // `global-hotkey`'s own X11 event thread, not the
                        // main thread — returns immediately, so that
                        // thread is free to keep servicing register()/
                        // unregister() acks no matter what `dispatch`
                        // ends up blocking on downstream.
                        let app = app.clone();
                        std::thread::spawn(move || dispatch(&app, action));
                    }
                }
            })
            .build(),
    ) {
        log::warn!("failed to initialize global-shortcut plugin: {e}; OpenRay will run without global hotkeys");
        let _ = handle.emit(HOTKEY_UNAVAILABLE_EVENT, e.to_string());
        return;
    }

    handle.state::<HotkeyBindings>().plugin_ready.store(true, Ordering::SeqCst);
}

/// Rebuilds every registered shortcut (palette + per-command) from current
/// settings. The single entry point for any hotkey mutation — palette
/// rebind, command hotkey assignment/clear, or a command becoming
/// enabled/disabled/uninstalled all funnel here rather than poking the
/// plugin directly, so `HotkeyBindings` never drifts from what's actually
/// registered.
pub fn sync_bindings(app: &AppHandle, palette_hotkey: &str, command_settings: &HashMap<String, CommandSettingsEntry>, commands: &[Command]) {
    let desired = build_desired_bindings(palette_hotkey, command_settings, commands);

    #[cfg(target_os = "linux")]
    if is_wayland() {
        let shortcuts = desired
            .iter()
            .filter_map(|binding| {
                let id = match &binding.action {
                    HotkeyAction::TogglePalette => "toggle-palette".to_string(),
                    HotkeyAction::RunCommand(command_id) => format!("cmd:{command_id}"),
                };
                Some(crate::infrastructure::wayland_hotkey::PortalShortcut {
                    id,
                    trigger: hotkey_to_xdg_trigger(&binding.hotkey),
                    description: binding.description.clone(),
                })
            })
            .collect();
        crate::infrastructure::wayland_hotkey::spawn_registration_multi(app.clone(), shortcuts);
        return;
    }

    let Some(bindings) = app.try_state::<HotkeyBindings>() else { return };
    if !bindings.plugin_ready.load(Ordering::SeqCst) {
        return;
    }

    let mut desired_map = HashMap::new();
    for binding in &desired {
        match Shortcut::from_str(&binding.hotkey) {
            Ok(shortcut) => {
                desired_map.insert(shortcut, binding.action.clone());
            }
            Err(e) => log::warn!("invalid hotkey '{}': {e}", binding.hotkey),
        }
    }

    // The plugin call happens on a spawned thread under the shared lock —
    // see HOTKEY_PLUGIN_LOCK's doc comment. Fire-and-forget: every caller
    // (a settings-change command) already returns `Ok(())` without
    // waiting on the result, so finishing a beat later off-thread changes
    // nothing observable.
    let app = app.clone();
    std::thread::spawn(move || {
        let _serialize = HOTKEY_PLUGIN_LOCK.lock().unwrap();

        let Some(bindings) = app.try_state::<HotkeyBindings>() else { return };
        let previous = bindings.snapshot();

        let gs = app.global_shortcut();
        let mut next = HashMap::new();

        for (shortcut, action) in desired_map {
            if previous.contains_key(&shortcut) {
                next.insert(shortcut, action);
                continue;
            }
            match gs.register(shortcut) {
                Ok(()) => {
                    next.insert(shortcut, action);
                }
                Err(e) => {
                    log::warn!("failed to register hotkey: {e} — it's likely already bound by another app or the desktop");
                    let _ = app.emit(HOTKEY_UNAVAILABLE_EVENT, e.to_string());
                }
            }
        }

        for shortcut in previous.keys() {
            if !next.contains_key(shortcut) {
                if let Err(e) = gs.unregister(*shortcut) {
                    log::warn!("failed to unregister hotkey: {e}");
                }
            }
        }

        bindings.replace(next);
    });
}

/// Converts OpenRay's internal hotkey format (`tauri-plugin-global-shortcut`'s
/// "cmdOrCtrl+space"-style strings, see settings.rs, with the non-modifier
/// key as a JS `event.code` value like "KeyR"/"Digit5") into the XDG
/// "shortcuts" spec trigger format the portal expects ("CTRL+r" — upper-case
/// modifier names, no "OrCtrl"/"cmd" aliasing since Wayland sessions are
/// never macOS, and "Key"/"Digit" prefixes stripped from the main key so
/// "KeyR" becomes "r" and "Digit5" becomes "5"). This is a hint the
/// compositor may ignore entirely (the user can rebind through its own UI),
/// so a best-effort mapping is sufficient.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn hotkey_to_xdg_trigger(hotkey: &str) -> String {
    hotkey
        .split('+')
        .map(|part| match part.to_ascii_lowercase().as_str() {
            "cmdorctrl" | "commandorcontrol" | "ctrl" | "control" => "CTRL".to_string(),
            "cmd" | "command" | "super" | "meta" => "SUPER".to_string(),
            "alt" | "option" => "ALT".to_string(),
            "shift" => "SHIFT".to_string(),
            "space" => "SPACE".to_string(),
            _ => {
                if let Some(letter) = part.strip_prefix("Key") {
                    letter.to_ascii_lowercase()
                } else if let Some(digit) = part.strip_prefix("Digit") {
                    digit.to_string()
                } else {
                    part.to_string()
                }
            }
        })
        .collect::<Vec<_>>()
        .join("+")
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn converts_default_hotkey_to_xdg_trigger_format() {
        assert_eq!(hotkey_to_xdg_trigger("Alt+Space"), "ALT+SPACE");
    }

    #[test]
    fn maps_cmd_or_ctrl_alias_to_ctrl() {
        assert_eq!(hotkey_to_xdg_trigger("CmdOrCtrl+Space"), "CTRL+SPACE");
    }

    #[test]
    fn preserves_unrecognized_key_names_as_is() {
        assert_eq!(hotkey_to_xdg_trigger("Ctrl+F1"), "CTRL+F1");
    }

    #[test]
    fn strips_key_prefix_and_lowercases_the_letter() {
        assert_eq!(hotkey_to_xdg_trigger("Ctrl+Alt+KeyR"), "CTRL+ALT+r");
    }

    #[test]
    fn strips_digit_prefix() {
        assert_eq!(hotkey_to_xdg_trigger("Ctrl+Digit5"), "CTRL+5");
    }
}

#[cfg(test)]
mod bindings_tests {
    use super::*;
    use crate::application::command_settings::CommandSettingsEntry;
    use crate::domain::command::CommandKind;

    fn command(id: &str) -> Command {
        Command {
            id: id.to_string(),
            title: format!("Title for {id}"),
            subtitle: None,
            icon: None,
            kind: CommandKind::App,
            keywords: vec![],
            arguments: Vec::new(),
        }
    }

    #[test]
    fn always_includes_the_palette_toggle() {
        let desired = build_desired_bindings("Alt+Space", &HashMap::new(), &[]);
        assert_eq!(desired.len(), 1);
        assert_eq!(desired[0].hotkey, "Alt+Space");
        assert_eq!(desired[0].action, HotkeyAction::TogglePalette);
    }

    #[test]
    fn includes_enabled_commands_with_a_hotkey() {
        let mut settings = HashMap::new();
        settings.insert(
            "firefox.desktop".to_string(),
            CommandSettingsEntry { alias: None, hotkey: Some("Ctrl+Alt+KeyF".into()), enabled: true },
        );
        let desired = build_desired_bindings("Alt+Space", &settings, &[command("firefox.desktop")]);
        assert_eq!(desired.len(), 2);
        assert_eq!(desired[1].action, HotkeyAction::RunCommand("firefox.desktop".into()));
    }

    #[test]
    fn skips_disabled_commands() {
        let mut settings = HashMap::new();
        settings.insert(
            "firefox.desktop".to_string(),
            CommandSettingsEntry { alias: None, hotkey: Some("Ctrl+Alt+KeyF".into()), enabled: false },
        );
        let desired = build_desired_bindings("Alt+Space", &settings, &[command("firefox.desktop")]);
        assert_eq!(desired.len(), 1);
    }

    #[test]
    fn skips_commands_without_a_hotkey() {
        let mut settings = HashMap::new();
        settings.insert(
            "firefox.desktop".to_string(),
            CommandSettingsEntry { alias: None, hotkey: None, enabled: true },
        );
        let desired = build_desired_bindings("Alt+Space", &settings, &[command("firefox.desktop")]);
        assert_eq!(desired.len(), 1);
    }

    #[test]
    fn skips_commands_no_longer_in_the_registry() {
        let mut settings = HashMap::new();
        settings.insert(
            "uninstalled.desktop".to_string(),
            CommandSettingsEntry { alias: None, hotkey: Some("Ctrl+Alt+KeyU".into()), enabled: true },
        );
        // `commands` (the live registry snapshot) doesn't include it.
        let desired = build_desired_bindings("Alt+Space", &settings, &[]);
        assert_eq!(desired.len(), 1);
    }
}
