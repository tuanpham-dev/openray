mod api;
mod application;
mod domain;
mod error;
mod infrastructure;

use std::sync::Arc;

use tauri::{Emitter, Manager, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;

use crate::application::app_provider::AppCommandProvider;
use crate::application::clipboard::ClipboardHistoryProvider;
use crate::application::command_settings::CommandSettingsStore;
use crate::application::extension_bridge;
use crate::application::extension_commands::ExtensionCommandProvider;
use crate::application::extension_storage::ExtensionStorage;
use crate::application::extensions_registry::ExtensionsRegistry;
use crate::application::navigation::NavigationProvider;
use crate::application::registry::CommandRegistry;
use crate::application::root_commands::RootCommandProvider;
use crate::application::file_search::FileSearchProvider;
use crate::application::screenshots::ScreenshotsProvider;
use crate::application::settings_provider::SettingsCommandProvider;
use crate::application::sync::SyncProvider;
use crate::application::state::AppState;
use crate::domain::ports::CommandProvider;
use crate::infrastructure::clipboard_watcher::ClipboardWatcher;
use crate::infrastructure::db::UsageRepository;
use crate::infrastructure::extension_host::process::ExtensionHost;
use crate::infrastructure::hotkey::HotkeyBindings;
use crate::infrastructure::paste::SystemPasteInjector;
use crate::infrastructure::platform::PlatformAppScanner;
use crate::infrastructure::settings::SettingsStore;
use crate::infrastructure::window::{self, PALETTE_WINDOW_LABEL};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
      let _ = window::toggle_palette(app);
    }))
    .plugin(tauri_plugin_clipboard_manager::init())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
    .plugin(tauri_plugin_shell::init())
    .invoke_handler(tauri::generate_handler![
      // api::window
      api::window::hide_palette,
      api::window::get_system_theme,
      api::window::open_url,
      api::window::close_extension_window,
      // api::icons
      api::icons::resolve_theme_icon,
      // api::search
      api::search::search,
      api::search::run_command,
      api::search::run_command_with_argument,
      // api::settings
      api::settings::get_settings,
      api::settings::update_settings,
      api::settings::update_hotkey,
      api::settings::open_settings,
      api::settings::list_settings_commands,
      api::settings::list_command_settings,
      api::settings::set_command_hotkey,
      api::settings::set_command_alias,
      api::settings::set_command_enabled,
      api::settings::clear_translate_history,
      // api::extensions
      api::extensions::list_extensions,
      api::extensions::set_extension_enabled,
      api::extensions::install_extension_from_path,
      api::extensions::install_extension_from_slug,
      api::extensions::uninstall_extension,
      api::extensions::extension_preference_definitions,
      api::extensions::extension_preference_values,
      api::extensions::set_extension_preference_value,
      // api::extension_host
      api::extension_host::run_extension_command,
      api::extension_host::unmount_extension_command,
      api::extension_host::invoke_extension_callback,
      api::extension_host::resolve_confirm_alert,
      api::extension_host::notify_extension_window_ready,
      // api::screenshots
      api::screenshots::screenshot_ocr_status,
      // api::sync
      api::sync::get_sync_status,
      api::sync::sync_now,
      api::sync::sync_set_passphrase,
    ])
    .setup(|app| {
      setup_window_chrome(app)?;
      let state = build_app_state(app)?;
      // Applied once here, not inside `setup_window_chrome` (which builds
      // the tray) — `Arc<SettingsStore>` isn't managed until
      // `build_app_state` runs, and `setup_window_chrome` runs first.
      if !state.settings.get().show_tray_icon {
        if let Some(tray) = app.tray_by_id(infrastructure::tray::TRAY_ID) {
          let _ = tray.set_visible(false);
        }
      }
      app.manage(state);
      spawn_background_workers(app.handle());

      app.state::<AppState>().sync_hotkey_bindings(&app.handle().clone());

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

/// Dev-only logging, the palette window's macOS panel conversion and
/// focus/theme event handlers, hotkey-plugin readiness state, and the
/// tray icon — everything about how the app *presents*, none of it
/// touching `AppState`. Split from `run`'s `.setup()` closure (T8,
/// `plans/refactor-extension-platform.md`) purely for readability; no
/// behavior change.
fn setup_window_chrome(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
  if cfg!(debug_assertions) {
    app.handle().plugin(
      tauri_plugin_log::Builder::default()
        .level(log::LevelFilter::Info)
        .build(),
    )?;
  }

  if let Some(palette) = app.get_webview_window(PALETTE_WINDOW_LABEL) {
    #[cfg(target_os = "macos")]
    {
      app.set_activation_policy(tauri::ActivationPolicy::Accessory);
      infrastructure::platform::macos_panel::install(&palette)?;
    }

    let app_handle = app.handle().clone();
    palette.on_window_event(move |event| {
      match event {
        WindowEvent::Focused(false) => {
          // A grabbed keypress (the transient Escape grab, the toggle
          // hotkey) surfaces as a focus-out with the real input focus
          // unmoved — hiding on it would close the palette on every
          // Escape meant for in-palette navigation. Only a focus loss
          // the X server corroborates counts as "the user left".
          #[cfg(target_os = "linux")]
          if infrastructure::platform::linux_focus::input_focus_is_ours() {
            return;
          }
          let _ = window::hide_palette(&app_handle);
        }
        // `theme` is tao's own detection — on Linux that goes through
        // the XDG portal, which silently defaults to light on
        // non-GNOME sessions (see `window::system_theme`'s doc
        // comment). Forwarding it directly overwrote the correct
        // gsettings-derived value the frontend fetched at startup the
        // moment this event fired (observed: palette opens dark,
        // then flips to light). The event still means "something
        // changed, re-check" — just re-derive the value through the
        // reliable path instead of trusting the payload.
        WindowEvent::ThemeChanged(_) => {
          let _ = app_handle.emit("system-theme-changed", window::system_theme(&app_handle));
        }
        _ => {}
      }
    });
  }

  app.manage(HotkeyBindings::new());
  infrastructure::hotkey::init(app);
  infrastructure::tray::build(app)?;

  Ok(())
}

/// Constructs every provider exactly once (as `Arc`, shared into both the
/// registry and the returned `AppState` — see `AppState`'s doc comment
/// for why a second, independent construction was a real bug) and
/// assembles `AppState`. The caller is responsible for `app.manage(state)`.
fn build_app_state(app: &tauri::App) -> Result<AppState, Box<dyn std::error::Error>> {
  // Separately managed as its own `Arc<SettingsStore>` (in addition to
  // living on `AppState.settings`, the same `Arc`) so
  // `infrastructure/window.rs` can read it via `try_state` without
  // importing `application::state::AppState` — see `AppState`'s doc
  // comment on the `settings` field.
  let settings = Arc::new(SettingsStore::load(app.handle().clone())?);
  app.manage(Arc::clone(&settings));

  let db_connection = infrastructure::db::open(app.handle())?;

  let clipboard = Arc::new(ClipboardHistoryProvider::new(db_connection.clone(), Box::new(SystemPasteInjector)));
  let extensions = Arc::new(ExtensionsRegistry::new(db_connection.clone()));
  register_builtin_extensions(app.handle(), &extensions);
  let root_commands = Arc::new(RootCommandProvider::new(app.handle().clone()));
  let navigation = Arc::new(NavigationProvider::new(Box::new(PlatformAppScanner::new())));
  let screenshots = Arc::new(ScreenshotsProvider::new(
    app.handle().clone(),
    db_connection.clone(),
    Box::new(SystemPasteInjector),
  ));
  let file_search = Arc::new(FileSearchProvider::new(app.handle().clone(), db_connection.clone()));
  let mut registry = CommandRegistry::new();
  registry.register(Arc::new(AppCommandProvider::new(Box::new(PlatformAppScanner::new()))));
  registry.register(Arc::new(SettingsCommandProvider::new(app.handle().clone())));
  registry.register(Arc::new(ExtensionCommandProvider::with_app(extensions.clone(), app.handle().clone())));
  registry.register(root_commands.clone() as Arc<dyn CommandProvider>);

  // Captured clipboard images live beside the database, so they're
  // covered by the same app-data lifetime and the asset-protocol scope
  // declared in tauri.conf.json.
  let clipboard_images_dir = app.path().app_data_dir().ok().map(|dir| dir.join("clipboard-images"));
  let clipboard_watcher = ClipboardWatcher::start(db_connection.clone(), clipboard_images_dir, Arc::clone(&settings));
  clipboard_watcher.set_enabled(extensions.is_enabled(
    crate::application::extensions_registry::CLIPBOARD_HISTORY_ID,
  ));

  let extension_host = ExtensionHost::new(app.handle().clone());
  extension_host.set_request_handler(std::sync::Arc::new(|app, method, params| {
    Box::pin(extension_bridge::dispatch_request(app, method, params))
  }));
  extension_host.set_notification_handler(std::sync::Arc::new(extension_bridge::dispatch_notification));

  Ok(AppState {
    registry,
    usage: UsageRepository::new(db_connection.clone()),
    clipboard,
    clipboard_watcher,
    settings,
    extensions,
    root_commands,
    inline_queries: crate::application::inline_query::InlineQueryDispatcher::new(),
    extension_host,
    command_settings: CommandSettingsStore::new(db_connection.clone()),
    extension_storage: ExtensionStorage::new(db_connection.clone()),
    extension_windows: window::ExtensionWindows::new(app.handle().clone()),
    navigation,
    screenshots,
    file_search,
    sync: SyncProvider::start(app.handle().clone(), db_connection),
    confirm_alerts: Default::default(),
    // A plain OS thread, not a tokio task: guarantees this one-time zbus
    // (blocking API) call never nests inside whatever async context
    // `build_app_state` itself happens to run in — see `platform_info`
    // field's doc comment on `AppState`.
    platform_info: std::thread::spawn(crate::infrastructure::platform_info::snapshot)
      .join()
      .unwrap_or_else(|_| crate::infrastructure::platform_info::snapshot_conservative()),
  })
}

/// Registers every first-party extension under `extensions/` (dev: the
/// repo directory directly; release: `tauri.conf.json`'s bundled
/// `extensions` resource) as `source="builtin"` — same `register_installed`
/// path a user-installed extension goes through, so search/settings treat
/// both uniformly (`ExtensionsPane.tsx` already renders any `source ==
/// "builtin"` row as "Built-in", matching the *native-feature* builtin rows
/// `ExtensionsRegistry::new`'s own seeding already produces — no new
/// `source` value, this is the first real filesystem-backed use of the
/// existing one).
///
/// Parses each `package.json` directly with `serde_json` rather than
/// calling into the Node sidecar's own `readManifest` (the sidecar is
/// intentionally lazy — not running yet at this point in startup, and
/// forcing an early spawn just to parse JSON would cost every launch a
/// Node startup, not just extension use). `ExtensionManifest`'s `#[derive
/// (Deserialize)]` already tolerates a real `package.json`'s extra fields
/// (no `deny_unknown_fields`), so this is the exact same manifest shape
/// the install RPC path deserializes, read one layer more directly.
///
/// Building each extension's `.openray/build/` output is `scripts/
/// build-builtin-extensions.mjs`'s job (run before the Rust build, like
/// the frontend's own `beforeBuildCommand`) — this only registers
/// *already-built* extensions; it never invokes esbuild itself.
fn register_builtin_extensions(app: &tauri::AppHandle, extensions: &ExtensionsRegistry) {
  let root = if cfg!(debug_assertions) {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../extensions")
  } else {
    match app.path().resource_dir() {
      Ok(dir) => dir.join("extensions"),
      Err(e) => {
        log::warn!("could not resolve resource dir for builtin extensions: {e}");
        return;
      }
    }
  };

  let Ok(entries) = std::fs::read_dir(&root) else { return };
  for entry in entries.flatten() {
    let dir = entry.path();
    if !dir.is_dir() {
      continue;
    }
    let manifest_path = dir.join("package.json");
    let raw = match std::fs::read_to_string(&manifest_path) {
      Ok(raw) => raw,
      Err(_) => continue,
    };
    let manifest: crate::infrastructure::extension_host::protocol::ExtensionManifest = match serde_json::from_str(&raw) {
      Ok(m) => m,
      Err(e) => {
        log::warn!("skipping builtin extension at {}: invalid manifest ({e})", dir.display());
        continue;
      }
    };
    let id = manifest.name.clone();
    if let Err(e) = extensions.register_installed(&id, &manifest, &dir.to_string_lossy(), "builtin") {
      log::warn!("failed to register builtin extension '{id}': {e}");
    }
  }
}

/// Everything spawned independently of `AppState` construction (the
/// clipboard watcher and sync worker start their own threads inline as
/// part of `build_app_state`, since they're stored as `AppState` fields —
/// this is for the rest).
fn spawn_background_workers(app: &tauri::AppHandle) {
  // T23: currency-rate refresh moved into the calculator extension's own
  // root-provider listing (`extensions/calculator/src/rates.ts`),
  // triggered here for free by `spawn_root_provider_startup` (T14) —
  // reproducing native `application::calculator::currency`'s
  // once-at-startup fetch/cache contract with no dedicated call site.
  spawn_root_provider_startup(app);
}

/// T14: requests every installed `root-provider` command's listing once,
/// at startup — "mounted at host start" per the plan. This is also what
/// causes the sidecar to spawn eagerly on launch rather than staying
/// fully lazy (T9's original, still-accurate-for-everything-else
/// behavior) whenever at least one such command is installed; with none
/// installed this is a no-op and the sidecar stays lazy exactly as
/// before.
fn spawn_root_provider_startup(app: &tauri::AppHandle) {
  let Some(state) = app.try_state::<AppState>() else { return };
  let root_providers: Vec<(String, String)> = state
    .extensions
    .installed_commands()
    .into_iter()
    .filter(|c| c.mode == "root-provider")
    .map(|c| (c.extension_id, c.name))
    .collect();
  if root_providers.is_empty() {
    return;
  }

  let app = app.clone();
  tauri::async_runtime::spawn(async move {
    for (extension_id, command_name) in root_providers {
      if let Err(e) = application::extension_commands::launch_root_provider_listing(&app, &extension_id, &command_name).await {
        log::warn!("failed to request root-provider listing for '{extension_id}:{command_name}': {e}");
      }
    }
  });
}
