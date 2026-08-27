use std::sync::Arc;

use crate::application::clipboard::ClipboardHistoryProvider;
use crate::application::command_settings::CommandSettingsStore;
use crate::application::extension_storage::ExtensionStorage;
use crate::application::extensions_registry::ExtensionsRegistry;
use crate::application::file_search::FileSearchProvider;
use crate::application::inline_query::InlineQueryDispatcher;
use crate::application::navigation::NavigationProvider;
use crate::application::registry::CommandRegistry;
use crate::application::root_commands::RootCommandProvider;
use crate::application::screenshots::ScreenshotsProvider;
use crate::infrastructure::clipboard_watcher::ClipboardWatcher;
use crate::infrastructure::db::{SharedConnection, UsageRepository};
use crate::infrastructure::extension_host::process::ExtensionHost;
use crate::infrastructure::settings::SettingsStore;
use crate::infrastructure::window::ExtensionWindows;

/// The providers below are `Arc<T>` — not owned values — because the
/// exact same instance is also registered into `AppState.registry`'s
/// `CommandRegistry`. Building two separate instances (one for the
/// registry, one for `AppState`) was the previous shape and it caused
/// real state divergence: the now-deleted native `NotesProvider` was the
/// motivating case — `active_note_id` existed as two independent mutexes
/// that never observed each other's writes, so opening a note via the
/// palette (which goes through the registry) and then reading it back via
/// a separate command (which read `state.notes` directly) could see
/// stale/absent state. See `lib.rs`'s `build_app_state` for the single
/// construction site.
pub struct AppState {
    pub registry: CommandRegistry,
    pub usage: UsageRepository,
    pub clipboard: Arc<ClipboardHistoryProvider>,
    pub clipboard_watcher: ClipboardWatcher,
    /// Also separately managed as `Arc<SettingsStore>` (see `lib.rs`) so
    /// `infrastructure/window.rs` can read it without reaching into
    /// `AppState` — an infrastructure module importing an application-layer
    /// type would invert the intended dependency direction.
    pub settings: Arc<SettingsStore>,
    pub extensions: Arc<ExtensionsRegistry>,
    pub root_commands: Arc<RootCommandProvider>,
    /// T21: tracks the most recently dispatched inline-query request id —
    /// see `inline_query::dispatch`'s doc comment for why a plain global
    /// counter (not per-extension) is the correct staleness gate.
    pub inline_queries: InlineQueryDispatcher,
    pub extension_host: ExtensionHost<tauri::Wry>,
    pub command_settings: CommandSettingsStore,
    pub extension_storage: ExtensionStorage,
    /// T24: creates/closes/focuses extension-owned windows on behalf of
    /// `extension_bridge`'s otherwise-generic `dispatch_request` — see
    /// `ExtensionWindows`'s own doc comment for why it exists as a
    /// concrete-Wry-capturing struct rather than a bare function call.
    pub extension_windows: ExtensionWindows,
    pub navigation: Arc<NavigationProvider>,
    pub screenshots: Arc<ScreenshotsProvider>,
    pub file_search: Arc<FileSearchProvider>,
    /// The shared SQLite handle, for commands that need raw connection
    /// access rather than one of the typed repositories above —
    /// `api::transfer`'s import/export, which reads and writes across
    /// every synced table at once, is the only such caller today.
    pub db: SharedConnection,
    pub confirm_alerts: crate::application::extension_bridge::ConfirmAlertRegistry,
    /// Computed once at startup (see `lib.rs`'s `build_app_state`), not
    /// per-launch — `platform_info::snapshot()` isn't safe to call from
    /// the async context `extension_commands::launch` itself runs in
    /// (`menu_bar::linux::available()` uses zbus's *blocking* API
    /// internally, which panics — "Cannot start a runtime from within a
    /// runtime" — if entered from a thread tokio is already driving;
    /// confirmed live via T12's fixture-extension verification). None of
    /// these facts change during a running session anyway (display
    /// server, D-Bus/X11 availability), so caching removes both the
    /// hazard and a real per-launch D-Bus round trip.
    pub platform_info: crate::infrastructure::platform_info::PlatformInfo,
}

impl AppState {
    /// Resyncs registered global hotkeys from current settings/command
    /// state. Lives here (not `infrastructure::hotkey::sync_bindings`
    /// itself) because it's the one piece of code that legitimately needs
    /// to know both `AppState`'s shape and `infrastructure::hotkey`'s API —
    /// `sync_bindings` itself takes plain data, not `&AppState`, so
    /// `infrastructure/` never has to import an `application/` type to
    /// call it.
    pub fn sync_hotkey_bindings(&self, app: &tauri::AppHandle) {
        let palette_hotkey = self.settings.get().hotkey;
        let command_settings = self.command_settings.all();
        let commands = self.registry.all_commands();
        crate::infrastructure::hotkey::sync_bindings(app, &palette_hotkey, &command_settings, &commands);
    }
}
