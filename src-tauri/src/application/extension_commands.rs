use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::application::extension_bridge::EXTENSION_TOAST_EVENT;
use crate::application::extensions_registry::ExtensionsRegistry;
use crate::application::state::AppState;
use crate::domain::command::{Command, CommandKind};
use crate::domain::ports::CommandProvider;
use crate::error::Error;

pub fn extension_command_id(extension_id: &str, command_name: &str) -> String {
    format!("ext:{extension_id}:{command_name}")
}

/// The `environment`/`platform` launch-prop pair every mount/call variant
/// sends — factored out once all three (`launch`, `launch_root_command`,
/// `launch_root_provider_listing`) needed it identically.
pub(crate) fn environment_and_platform_json(state: &AppState, install_path: &str) -> (serde_json::Value, serde_json::Value) {
    let theme = match state.settings.get().theme.as_str() {
        "dark" => "dark",
        _ => "light",
    };
    let environment = json!({
        "raycastVersion": env!("CARGO_PKG_VERSION"),
        // The *assets directory*, matching Raycast's own definition of
        // `environment.assetsPath` — extensions reference their files
        // relative to it (`icon={{ source: "../assets/x.png" }}`), and the
        // shim resolves those against this. Sending the install root
        // instead resolved every such icon one directory too high, so it
        // rendered as literal text rather than an image.
        "assetsPath": format!("{install_path}/assets"),
        "supportPath": install_path,
        "isDevelopment": cfg!(debug_assertions),
        "theme": theme,
    });
    // Resolved once at startup, not a live bridge call or a per-launch
    // computation — see `AppState::platform_info`'s doc comment for why
    // (a real async-context/blocking-zbus-call hazard, not just an
    // optimization). `@openray/extras`'s `platform`/`capabilities` exports read
    // it straight out of CommandContext.
    (environment, json!(state.platform_info))
}

/// Inverse of [`extension_command_id`]. The command name never contains a
/// colon, so splitting on the *last* one keeps extension ids that do.
pub fn parse_extension_command_id(id: &str) -> Option<(&str, &str)> {
    id.strip_prefix("ext:")?.rsplit_once(':')
}

/// An extension command's manifest-declared mode (`"view"` / `"no-view"` /
/// `"menu-bar"`), or the equivalent for a command that isn't a real
/// manifest command at all — a root-provider-contributed row, whose own
/// `opens_view` flag stands in for a mode it doesn't have.
///
/// Shared by `run_extension_command` (decides whether the palette needs
/// hiding before launch) and the CLI control-socket runner (decides
/// whether a command can run headlessly at all) so the two never drift
/// into disagreeing about what a given id does.
pub fn resolve_mode(state: &AppState, extension_id: &str, command_name: &str) -> String {
    let manifest_mode = state
        .extensions
        .installed_commands()
        .into_iter()
        .find(|c| c.extension_id == extension_id && c.name == command_name)
        .map(|c| c.mode);
    match manifest_mode {
        Some(mode) => mode,
        None => match state.root_commands.host_command_name_for(extension_id, command_name) {
            Some(_) => {
                let full_id = extension_command_id(extension_id, command_name);
                let opens_view = state.root_commands.flags_for(&full_id).map(|(_, opens_view)| opens_view).unwrap_or(false);
                if opens_view { "view".to_string() } else { "no-view".to_string() }
            }
            None => "view".to_string(),
        },
    }
}

/// A command's `required` arguments the caller didn't supply — the gate a
/// headless CLI run needs and the GUI doesn't, since the palette's
/// argument bar physically cannot submit without filling them in first.
fn missing_required_arguments(command: &Command, arguments: &std::collections::HashMap<String, String>) -> Vec<String> {
    command.arguments.iter().filter(|argument| argument.required && !arguments.contains_key(&argument.name)).map(|argument| argument.name.clone()).collect()
}

/// A CLI-triggered launch of a view/menu-bar command: the frontend has no
/// invoke call to react to (unlike every click/hotkey launch, which calls
/// `run_extension_command` itself and switches views on its own resolved
/// value — see `App.tsx`'s `launchExtensionCommand`), so `run_headless`
/// shows the palette and emits this instead, carrying exactly the
/// arguments `launchExtensionCommand` needs. Mirrors the one other place
/// that already couples "show the palette" with "launch a command neither
/// of which the frontend initiated" — the global-hotkey path
/// (`hotkey_dispatch.rs`'s `show_palette` + `hotkey-command` event).
pub const CLI_RUN_EXTENSION_COMMAND_EVENT: &str = "cli-run-extension-command";

/// Runs a command for the CLI's control-socket `command.run`. A no-view id
/// runs headlessly and returns once dispatched, same as before. A view/
/// menu-bar id can't run headlessly — there's nothing to render into — so
/// this shows the palette and emits [`CLI_RUN_EXTENSION_COMMAND_EVENT`]
/// for the frontend to actually launch (mirroring the hotkey path, not a
/// second copy of the mount logic `launch` already owns): the *frontend's*
/// own `run_extension_command` invoke ends up doing the actual mount, so
/// this function does not call `launch` itself for that branch.
///
/// `id` is the same opaque id `CommandRegistry` already keys on — a flat
/// app/builtin id, or `ext:{extension_id}:{command_name}` — so this
/// accepts exactly what `openray list` prints, no separate CLI id syntax
/// to keep in sync.
pub async fn run_headless(app: &AppHandle, state: &AppState, id: &str, arguments: &std::collections::HashMap<String, String>) -> Result<(), String> {
    let command = state.registry.all_commands().into_iter().find(|command| command.id == id).ok_or_else(|| format!("no provider found for command '{id}'"))?;
    // Root search and hotkey bindings (`api/search.rs`'s `disabled` set,
    // `hotkey.rs`'s `build_desired_bindings`) both already refuse a
    // disabled command by construction — it's simply never offered
    // anywhere a user discovers what to run. The CLI is the one surface
    // where a command is invoked by a typed/scripted id rather than
    // picked from a list, so disabled has to be checked explicitly here
    // to carry the same "won't run" guarantee.
    if !state.command_settings.all().get(id).map(|entry| entry.enabled).unwrap_or(true) {
        return Err(format!("'{id}' is disabled — enable it in Settings first"));
    }
    let missing = missing_required_arguments(&command, arguments);
    if !missing.is_empty() {
        return Err(format!("missing required argument(s): {}", missing.join(", ")));
    }

    match parse_extension_command_id(id) {
        Some((extension_id, command_name)) => {
            let mode = resolve_mode(state, extension_id, command_name);
            if mode == "no-view" {
                crate::infrastructure::window::hide_palette(app).map_err(|e| e.to_string())?;
                launch(app, extension_id, command_name, arguments).await?;
            } else {
                crate::infrastructure::window::show_palette(app).map_err(|e| e.to_string())?;
                app.emit(
                    CLI_RUN_EXTENSION_COMMAND_EVENT,
                    json!({
                        "extensionId": extension_id,
                        "commandName": command_name,
                        "title": command.title,
                        "icon": command.icon,
                        "arguments": arguments,
                    }),
                )
                .map_err(|e| e.to_string())?;
            }
        }
        None => {
            crate::infrastructure::window::hide_palette(app).map_err(|e| e.to_string())?;
            if arguments.is_empty() {
                state.registry.execute(id)?;
            } else {
                state.registry.execute_with_arguments(id, arguments)?;
            }
        }
    }

    state.usage.record_usage(id, crate::infrastructure::time::now_secs()).map_err(|e| e.to_string())
}

/// One entry in `openray list`'s output — everything the CLI needs to show
/// an id and, for extension commands, note whether running it stays
/// headless or brings the app forward to show its view.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListedCommand {
    pub id: String,
    pub title: String,
    pub extension_title: Option<String>,
    /// `"action"` for an app/builtin command (always headlessly runnable);
    /// otherwise the extension command's real mode from [`resolve_mode`].
    pub mode: String,
    pub arguments: Vec<crate::domain::command::CommandArgument>,
}

pub fn listable_commands(state: &AppState) -> Vec<ListedCommand> {
    let extension_titles: std::collections::HashMap<String, String> =
        state.extensions.installed_commands().into_iter().map(|c| (c.extension_id, c.extension_title)).collect();
    let command_settings = state.command_settings.all();
    state
        .registry
        .all_commands()
        .into_iter()
        // Matches `api/search.rs`'s `disabled` filtering and
        // `hotkey.rs`'s binding skip: a disabled command shouldn't show
        // up in `openray list` any more than it shows up in root search.
        .filter(|command| command_settings.get(&command.id).map(|entry| entry.enabled).unwrap_or(true))
        .map(|command| {
            let (mode, extension_title) = match parse_extension_command_id(&command.id) {
                Some((extension_id, command_name)) => (resolve_mode(state, extension_id, command_name), extension_titles.get(extension_id).cloned()),
                None => ("action".to_string(), None),
            };
            ListedCommand { id: command.id, title: command.title, extension_title, mode, arguments: command.arguments }
        })
        .collect()
}

/// Mounts and runs a command in the extension host.
///
/// One launch path for every entry point — the palette opening a view
/// command, and `registry.execute`/`execute_with_argument` running a
/// no-view one from a hotkey. Fire-and-forget by design: the command stays
/// mounted, streaming UI commits (if it renders anything) via the
/// `extension-ui-commit` event.
///
/// `argument` is the single value the native argument-bar mechanism
/// carries end to end (see `ExtensionArgument`'s doc comment on why only
/// the first declared argument is collected) — resolved here against that
/// first argument's declared `name` so the command receives it the same
/// shape a real Raycast `LaunchProps.arguments` object would use.
///
/// `command_name` isn't always a real manifest command: T14's dynamic
/// root-search rows reuse this exact `ext:{extensionId}:{name}` id shape
/// with `{name}` set to the row's own opaque id instead (so usage/
/// frecency/`command_settings` key on it unchanged, and both entry points
/// above reach a contributed row with zero code of their own). When
/// `command_name` doesn't match an installed manifest command, this falls
/// back to `RootCommandProvider` to resolve the *real* command to launch
/// (the row's host `root-provider` command) and switches to
/// `launch_root_command` instead — see `application::root_commands`'s
/// module doc comment for the full contract.
pub async fn launch<R: Runtime>(
    app: &AppHandle<R>,
    extension_id: &str,
    command_name: &str,
    arguments: &std::collections::HashMap<String, String>,
) -> Result<(), Error> {
    launch_with_context(app, extension_id, command_name, arguments, None, None).await
}

/// `launch` plus the extras a programmatic `launchCommand` carries — the
/// payload the target reads as `props.launchContext`, and how it was
/// started. Kept as one path with the user-initiated launch above so a
/// programmatic launch and a keyboard launch cannot drift apart.
pub async fn launch_with_context<R: Runtime>(
    app: &AppHandle<R>,
    extension_id: &str,
    command_name: &str,
    arguments: &std::collections::HashMap<String, String>,
    launch_context: Option<Value>,
    fallback_text: Option<String>,
) -> Result<(), Error> {
    let state = app.try_state::<AppState>().ok_or_else(|| Error::msg("app state not managed"))?;

    let is_real_command = state.extensions.installed_commands().iter().any(|c| c.extension_id == extension_id && c.name == command_name);

    if !is_real_command {
        if let Some(host_command_name) = state.root_commands.host_command_name_for(extension_id, command_name) {
            return launch_root_command(app, extension_id, &host_command_name, command_name, arguments).await;
        }
    }

    let entry = state
        .extensions
        .list()
        .into_iter()
        .find(|e| e.id == extension_id)
        .ok_or_else(|| Error::msg(format!("extension '{extension_id}' not found")))?;
    let path = entry.path.ok_or_else(|| Error::msg(format!("extension '{extension_id}' has no install path")))?;
    let command_path = format!("{path}/.openray/build/{command_name}.js");

    let preferences = state
        .extensions
        .resolve_preferences(extension_id, command_name)
        .map_err(|missing| Error::msg(format!("missing_required_preferences:{}", missing.join(","))))?;

    // Already keyed by the manifest's own argument names — the palette
    // collects them per field, so nothing has to be guessed here.
    let arguments = if arguments.is_empty() { None } else { Some(json!(arguments)) };

    let (environment, platform) = environment_and_platform_json(&state, &path);
    let params = json!({
        "extensionId": extension_id,
        "commandName": command_name,
        "commandPath": command_path,
        "preferences": preferences,
        "arguments": arguments,
        "launchContext": launch_context,
        "fallbackText": fallback_text,
        "environment": environment,
        "platform": platform,
    });

    Ok(state.extension_host.notify("extension.runCommand", Some(params)).await?)
}

/// Activates one dynamically-contributed root-search row — a distinct RPC
/// method (`extension.runRootCommand`, not `extension.runCommand`) since
/// what's mounted/called on the Node side is the host command's named
/// `execute` export, not its default export (the listing function
/// `extension.runRootProviderList` calls instead). See
/// `application::root_commands`'s module doc comment.
///
/// A row whose `opens_view` flag is set (T20) instead sends
/// `extension.runRootCommandView`, mounting the host command's named
/// `view` export the same way `extension.runCommand` mounts a real
/// manifest command's default export — `runner.ts`'s `mounts` map keys
/// this the identical `${extensionId}:${rowId}` shape the frontend's own
/// `unmountExtensionCommand(extensionId, commandName)` call already sends
/// for a root-provider row (`commandName` there is always the row id, not
/// the host command's own name — see `App.tsx`'s `launchExtensionCommand`),
/// so `extension.unmountCommand` needs no changes at all to tear a
/// mounted row's view down correctly.
async fn launch_root_command<R: Runtime>(
    app: &AppHandle<R>,
    extension_id: &str,
    host_command_name: &str,
    row_id: &str,
    arguments: &std::collections::HashMap<String, String>,
) -> Result<(), Error> {
    let state = app.try_state::<AppState>().ok_or_else(|| Error::msg("app state not managed"))?;

    let entry = state
        .extensions
        .list()
        .into_iter()
        .find(|e| e.id == extension_id)
        .ok_or_else(|| Error::msg(format!("extension '{extension_id}' not found")))?;
    let path = entry.path.ok_or_else(|| Error::msg(format!("extension '{extension_id}' has no install path")))?;
    let command_path = format!("{path}/.openray/build/{host_command_name}.js");

    let preferences = state
        .extensions
        .resolve_preferences(extension_id, host_command_name)
        .map_err(|missing| Error::msg(format!("missing_required_preferences:{}", missing.join(","))))?;

    let (environment, platform) = environment_and_platform_json(&state, &path);
    let params = json!({
        "extensionId": extension_id,
        "commandName": host_command_name,
        "commandPath": command_path,
        "preferences": preferences,
        "rowId": row_id,
        // A root-provider row takes a single anonymous value (see
        // `root_commands`' synthesized argument), so hand it whichever one
        // was collected.
        "argument": arguments.values().next(),
        "environment": environment,
        "platform": platform,
    });

    let full_id = extension_command_id(extension_id, row_id);
    let opens_view = state.root_commands.flags_for(&full_id).map(|(_, opens_view)| opens_view).unwrap_or(false);
    let method = if opens_view { "extension.runRootCommandView" } else { "extension.runRootCommand" };

    Ok(state.extension_host.notify(method, Some(params)).await?)
}

/// Requests (or re-requests) a `root-provider` command's listing —
/// fire-and-forget, same as `launch`: the actual rows arrive later via
/// the `extension.rootCommands` notification Node sends back. Called once
/// per installed `root-provider` command at startup (`lib.rs`) and again
/// whenever the extension calls `refreshRootCommands()`
/// (`host.system.refreshRootCommands`, `extension_bridge.rs`).
pub async fn launch_root_provider_listing<R: Runtime>(app: &AppHandle<R>, extension_id: &str, command_name: &str) -> Result<(), Error> {
    let state = app.try_state::<AppState>().ok_or_else(|| Error::msg("app state not managed"))?;

    let entry = state
        .extensions
        .list()
        .into_iter()
        .find(|e| e.id == extension_id)
        .ok_or_else(|| Error::msg(format!("extension '{extension_id}' not found")))?;
    let path = entry.path.ok_or_else(|| Error::msg(format!("extension '{extension_id}' has no install path")))?;
    let command_path = format!("{path}/.openray/build/{command_name}.js");

    let preferences = state
        .extensions
        .resolve_preferences(extension_id, command_name)
        .map_err(|missing| Error::msg(format!("missing_required_preferences:{}", missing.join(","))))?;

    let (environment, platform) = environment_and_platform_json(&state, &path);
    let params = json!({
        "extensionId": extension_id,
        "commandName": command_name,
        "commandPath": command_path,
        "preferences": preferences,
        "environment": environment,
        "platform": platform,
    });

    Ok(state.extension_host.notify("extension.runRootProviderList", Some(params)).await?)
}

/// Resolves one snippet to its final text + caret offset, without pasting —
/// the request half of snippet auto-expansion. Mirrors
/// `launch_root_command`'s param-building (so the snippet's `resolve` export
/// runs with the same command context, clipboard, and selection access its
/// `execute` export gets), but uses `call_checked` to await the returned
/// `{ text, cursorOffset }` value instead of firing and forgetting.
///
/// `snippet_id` is the row's own id (the `extension_storage` key), the same
/// value `execute` receives. The host command is the snippets extension's
/// root-provider command (`list`), resolved from the loaded root rows.
pub async fn resolve_snippet<R: Runtime>(app: &AppHandle<R>, snippet_id: &str) -> Result<serde_json::Value, Error> {
    let state = app.try_state::<AppState>().ok_or_else(|| Error::msg("app state not managed"))?;

    let extension_id = "snippets";
    let host_command_name = state
        .root_commands
        .host_command_name(extension_id)
        .ok_or_else(|| Error::msg("snippets root-provider is not loaded yet"))?;

    let entry = state
        .extensions
        .list()
        .into_iter()
        .find(|e| e.id == extension_id)
        .ok_or_else(|| Error::msg("extension 'snippets' not found"))?;
    let path = entry.path.ok_or_else(|| Error::msg("extension 'snippets' has no install path"))?;
    let command_path = format!("{path}/.openray/build/{host_command_name}.js");

    let preferences = state
        .extensions
        .resolve_preferences(extension_id, &host_command_name)
        .map_err(|missing| Error::msg(format!("missing_required_preferences:{}", missing.join(","))))?;

    let (environment, platform) = environment_and_platform_json(&state, &path);
    let params = json!({
        "extensionId": extension_id,
        "commandName": host_command_name,
        "commandPath": command_path,
        "preferences": preferences,
        "rowId": snippet_id,
        "environment": environment,
        "platform": platform,
    });

    Ok(state.extension_host.call_checked("extension.resolveSnippet", Some(params)).await?)
}

/// Builds the RPC params both Import/Export hooks share: which extension,
/// which bundle, and the same context every other launch variant passes.
///
/// The "command" here is the manifest's `export.entry` module, not a real
/// command — so preferences are resolved at extension scope (no command
/// name to narrow by), and a missing required preference is deliberately
/// *not* fatal: refusing to export someone's data because an unrelated
/// setting is blank would be worse than exporting it.
fn export_hook_params<R: Runtime>(app: &AppHandle<R>, extension_id: &str) -> Result<serde_json::Value, Error> {
    let state = app.try_state::<AppState>().ok_or_else(|| Error::msg("app state not managed"))?;

    let entry = state
        .extensions
        .list()
        .into_iter()
        .find(|e| e.id == extension_id)
        .ok_or_else(|| Error::msg(format!("extension '{extension_id}' not found")))?;
    let declaration = entry
        .export
        .as_ref()
        .ok_or_else(|| Error::msg(format!("extension '{extension_id}' does not declare import/export")))?;
    let entry_name = declaration.entry_name().to_string();
    let path = entry.path.clone().ok_or_else(|| Error::msg(format!("extension '{extension_id}' has no install path")))?;
    let command_path = format!("{path}/.openray/build/{entry_name}.js");

    let preferences = state.extensions.resolve_preferences(extension_id, &entry_name).unwrap_or_default();
    let (environment, platform) = environment_and_platform_json(&state, &path);

    Ok(json!({
        "extensionId": extension_id,
        "commandName": entry_name,
        "commandPath": command_path,
        "preferences": preferences,
        "environment": environment,
        "platform": platform,
    }))
}

/// Asks an extension for its exportable data, returning `{ version, data }`
/// exactly as its hook produced it — the host stores the value verbatim and
/// never interprets it.
///
/// Goes through `call_checked`, not `call`: one extension with a lot of data
/// must not be able to kill the shared host process and take every other
/// extension's export down with it.
pub async fn call_extension_export<R: Runtime>(app: &AppHandle<R>, extension_id: &str) -> Result<serde_json::Value, Error> {
    let params = export_hook_params(app, extension_id)?;
    let state = app.try_state::<AppState>().ok_or_else(|| Error::msg("app state not managed"))?;
    Ok(state.extension_host.call_checked("extension.exportData", Some(params)).await?)
}

/// Hands a previously exported payload back to the extension that produced
/// it. The extension owns the write; the host does not touch its data.
pub async fn call_extension_import<R: Runtime>(
    app: &AppHandle<R>,
    extension_id: &str,
    version: serde_json::Value,
    data: serde_json::Value,
) -> Result<(), Error> {
    let mut params = export_hook_params(app, extension_id)?;
    if let Some(object) = params.as_object_mut() {
        object.insert("version".to_string(), version);
        object.insert("data".to_string(), data);
    }
    let state = app.try_state::<AppState>().ok_or_else(|| Error::msg("app state not managed"))?;
    state.extension_host.call_checked("extension.importData", Some(params)).await?;
    Ok(())
}

/// Surfaces installed extension commands in search. Queries the registry
/// live on every call (rather than caching a snapshot) so a command
/// installed after startup appears immediately.
pub struct ExtensionCommandProvider {
    registry: Arc<ExtensionsRegistry>,
    /// Absent only in tests — executing needs the running app.
    app: Option<AppHandle>,
}

impl ExtensionCommandProvider {
    /// Test-only: a provider with no app handle can list and validate but
    /// not launch.
    #[cfg(test)]
    pub fn new(registry: Arc<ExtensionsRegistry>) -> Self {
        Self { registry, app: None }
    }

    pub fn with_app(registry: Arc<ExtensionsRegistry>, app: AppHandle) -> Self {
        Self { registry, app: Some(app) }
    }
}

impl CommandProvider for ExtensionCommandProvider {
    fn generation(&self) -> Option<u64> {
        Some(self.registry.generation())
    }

    fn commands(&self) -> Vec<Command> {
        self.registry
            .installed_commands()
            .into_iter()
            // A `root-provider` command is infrastructure, not a
            // user-facing row — its default export is a plain listing
            // function, not a component, so mounting it the normal way
            // (as `launch`/`runCommand` would, since it's a real
            // installed command) would try to render a non-component as
            // JSX. Its *contributed* rows (`RootCommandProvider`, T14)
            // are what search should show instead.
            .filter(|c| c.mode != "root-provider")
            .map(|c| Command {
                id: extension_command_id(&c.extension_id, &c.name),
                // The owning extension's name is shown beside the command
                // and searchable through it. Both matter: an extension's
                // commands are usually named for what they do ("Search
                // Page"), so without this the only way to find Wikipedia's
                // is to already know what its commands are called — and
                // "Search Page" on its own says nothing about where it
                // came from. Raycast shows and matches both for the same
                // reason. A command that declares its own subtitle keeps
                // it; the extension name still joins `keywords`.
                subtitle: c.subtitle.or_else(|| {
                    (c.extension_title != c.title).then(|| c.extension_title.clone())
                }),
                title: c.title,
                // Manifest commands don't carry a per-command icon in
                // storage today — fall back to the owning extension's own
                // manifest icon (see `EXTENSION_ICONS`' replacement).
                icon: c.extension_icon,
                kind: CommandKind::ExtensionCommand,
                keywords: {
                    let mut keywords = c.keywords;
                    if !keywords.iter().any(|k| k.eq_ignore_ascii_case(&c.extension_title)) {
                        keywords.push(c.extension_title);
                    }
                    keywords
                },
                arguments: c
                    .arguments
                    .into_iter()
                    .map(|a| crate::domain::command::CommandArgument {
                        name: a.name,
                        argument_type: a.argument_type,
                        placeholder: a.placeholder,
                        required: a.required,
                        data: a.data.map(|options| {
                            options
                                .into_iter()
                                .map(|o| crate::domain::command::CommandArgumentOption { title: o.title, value: o.value })
                                .collect()
                        }),
                    })
                    .collect(),
            })
            .collect()
    }

    /// Runs a command headless — the path a per-command hotkey takes for a
    /// no-view command. Validation is synchronous so a bad id errors to
    /// the caller; the launch itself is fire-and-forget, with failures
    /// surfaced through the toast event since there is no caller left to
    /// return them to.
    fn execute(&self, command_id: &str) -> Result<(), String> {
        self.spawn_launch(command_id, std::collections::HashMap::new())
    }

    /// The argument-bar path (`quicklink-argument` view → `registry.
    /// execute_with_argument`) for an extension command declaring
    /// `arguments[]`. A *view*-mode command reached this way still needs
    /// its view opened once mounted — `App.tsx`'s argument-bar submit
    /// handler special-cases `kind === 'extensionCommand'` to call
    /// `run_extension_command` (mode-aware) directly instead of routing
    /// through this generic entry point, so this override mainly exists
    /// for API consistency (any other caller of `execute_with_argument`
    /// on this provider, e.g. a future per-command hotkey) rather than
    /// being the primary path today.
    fn execute_with_arguments(
        &self,
        command_id: &str,
        arguments: &std::collections::HashMap<String, String>,
    ) -> Result<(), String> {
        self.spawn_launch(command_id, arguments.clone())
    }
}

impl ExtensionCommandProvider {
    fn spawn_launch(&self, command_id: &str, arguments: std::collections::HashMap<String, String>) -> Result<(), String> {
        let (extension_id, command_name) =
            parse_extension_command_id(command_id).ok_or_else(|| format!("'{command_id}' is not an extension command id"))?;

        let known = self
            .registry
            .installed_commands()
            .iter()
            .any(|c| c.extension_id == extension_id && c.name == command_name);
        if !known {
            return Err(format!("unknown extension command '{command_id}'"));
        }

        let app = self.app.clone().ok_or("extension commands can't run without an app handle")?;
        let (extension_id, command_name) = (extension_id.to_string(), command_name.to_string());

        tauri::async_runtime::spawn(async move {
            if let Err(e) = launch(&app, &extension_id, &command_name, &arguments).await {
                log::warn!("extension command '{extension_id}:{command_name}' failed: {e}");
                let _ = app.emit(
                    EXTENSION_TOAST_EVENT,
                    json!({ "id": "headless-command-error", "style": "FAILURE", "title": "Command failed", "message": e.to_string() }),
                );
            }
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::extension_host::protocol::{CommandMode, ExtensionCommandManifest, ExtensionManifest};
    use rusqlite::Connection;
    use std::sync::{Arc, Mutex};

    /// The extension tables as `migrations/` defines them, shared by every
    /// fixture below. Was four identical copies, which is exactly how a
    /// column added by a migration (0032's `version`/`source_url`) can pass
    /// `cargo check` and fail four tests at once — one definition means the
    /// next migration touches one place.
    const TEST_SCHEMA: &str = "CREATE TABLE extensions (id TEXT PRIMARY KEY, title TEXT NOT NULL, path TEXT,
            enabled INTEGER NOT NULL DEFAULT 1, description TEXT, source TEXT NOT NULL DEFAULT 'builtin', icon TEXT,
            export_json TEXT, version TEXT, source_url TEXT);
         CREATE TABLE extension_commands (extension_id TEXT NOT NULL, name TEXT NOT NULL, title TEXT NOT NULL,
            subtitle TEXT, description TEXT, mode TEXT NOT NULL, keywords TEXT, arguments TEXT,
            PRIMARY KEY (extension_id, name));
         CREATE TABLE extension_preference_definitions (extension_id TEXT NOT NULL, command_name TEXT NOT NULL DEFAULT '',
            name TEXT NOT NULL, preference_type TEXT NOT NULL, title TEXT, label TEXT, description TEXT,
            required INTEGER NOT NULL DEFAULT 0, default_value TEXT, placeholder TEXT, data TEXT,
            PRIMARY KEY (extension_id, command_name, name));
         CREATE TABLE extension_preference_values (extension_id TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL,
            PRIMARY KEY (extension_id, name));";

    fn provider_with_one_installed_command() -> ExtensionCommandProvider {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            TEST_SCHEMA,
        )
        .unwrap();
        let registry = Arc::new(ExtensionsRegistry::new(Arc::new(Mutex::new(conn))));
        registry
            .register_installed(
                "demo",
                &ExtensionManifest {
                    name: "demo".into(),
                    title: "Demo".into(),
                    description: None,
                    icon: None,
                    author: None,
                    categories: None,
            platforms: None,
                    commands: vec![ExtensionCommandManifest {
                        name: "search".into(),
                        title: "Search Demo".into(),
                        subtitle: Some("Demo".into()),
                        description: None,
                        mode: CommandMode::View,
                        icon: None,
                        keywords: Some(vec!["demo".into()]),
                        preferences: None,
                        arguments: None,
                    }],
                    preferences: None,
                    export: None,
                },
                "/tmp/demo",
                "installed",
            )
            .unwrap();
        ExtensionCommandProvider::new(registry)
    }

    fn provider_with_an_argument_declaring_command() -> ExtensionCommandProvider {
        use crate::infrastructure::extension_host::protocol::{ArgumentType, ExtensionArgument};

        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            TEST_SCHEMA,
        )
        .unwrap();
        let registry = Arc::new(ExtensionsRegistry::new(Arc::new(Mutex::new(conn))));
        registry
            .register_installed(
                "demo",
                &ExtensionManifest {
                    name: "demo".into(),
                    title: "Demo".into(),
                    description: None,
                    icon: None,
                    author: None,
                    categories: None,
            platforms: None,
                    commands: vec![ExtensionCommandManifest {
                        name: "greet".into(),
                        title: "Greet".into(),
                        subtitle: None,
                        description: None,
                        mode: CommandMode::NoView,
                        icon: None,
                        keywords: None,
                        preferences: None,
                        arguments: Some(vec![ExtensionArgument {
                            name: "name".into(),
                            argument_type: ArgumentType::Text,
                            placeholder: Some("Your name".into()),
                            required: true,
                            data: None,
                        }]),
                    }],
                    preferences: None,
                    export: None,
                },
                "/tmp/demo",
                "installed",
            )
            .unwrap();
        ExtensionCommandProvider::new(registry)
    }

    fn provider_with_a_root_provider_command() -> ExtensionCommandProvider {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            TEST_SCHEMA,
        )
        .unwrap();
        let registry = Arc::new(ExtensionsRegistry::new(Arc::new(Mutex::new(conn))));
        registry
            .register_installed(
                "quicklinks",
                &ExtensionManifest {
                    name: "quicklinks".into(),
                    title: "Quicklinks".into(),
                    description: None,
                    icon: None,
                    author: None,
                    categories: None,
            platforms: None,
                    commands: vec![ExtensionCommandManifest {
                        name: "list".into(),
                        title: "List Quicklinks".into(),
                        subtitle: None,
                        description: None,
                        mode: CommandMode::RootProvider,
                        icon: None,
                        keywords: None,
                        preferences: None,
                        arguments: None,
                    }],
                    preferences: None,
                    export: None,
                },
                "/tmp/quicklinks",
                "installed",
            )
            .unwrap();
        ExtensionCommandProvider::new(registry)
    }

    fn provider_with_an_extension_icon() -> ExtensionCommandProvider {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            TEST_SCHEMA,
        )
        .unwrap();
        let registry = Arc::new(ExtensionsRegistry::new(Arc::new(Mutex::new(conn))));
        registry
            .register_installed(
                "demo",
                &ExtensionManifest {
                    name: "demo".into(),
                    title: "Demo".into(),
                    description: None,
                    icon: Some("camera".into()),
                    author: None,
                    categories: None,
            platforms: None,
                    commands: vec![ExtensionCommandManifest {
                        name: "search".into(),
                        title: "Search Demo".into(),
                        subtitle: Some("Demo".into()),
                        description: None,
                        mode: CommandMode::View,
                        icon: None,
                        keywords: None,
                        preferences: None,
                        arguments: None,
                    }],
                    preferences: None,
                    export: None,
                },
                "/tmp/demo",
                "installed",
            )
            .unwrap();
        ExtensionCommandProvider::new(registry)
    }

    #[test]
    fn a_static_command_falls_back_to_its_extensions_manifest_icon() {
        let provider = provider_with_an_extension_icon();
        let commands = provider.commands();
        let demo = commands.iter().find(|c| c.id == "ext:demo:search").unwrap();
        assert_eq!(demo.icon.as_deref(), Some("camera"));
    }

    #[test]
    fn maps_installed_commands_with_a_namespaced_id() {
        let provider = provider_with_one_installed_command();
        let commands = provider.commands();
        let demo = commands.iter().find(|c| c.id == "ext:demo:search").unwrap();
        assert_eq!(demo.title, "Search Demo");
        assert_eq!(demo.kind, CommandKind::ExtensionCommand);
        assert_eq!(demo.keywords, vec!["demo".to_string()]);
        assert!(demo.arguments.is_empty(), "a command with no declared arguments must not ask for one");
    }

    #[test]
    fn a_root_provider_command_itself_is_never_a_search_result() {
        let provider = provider_with_a_root_provider_command();
        let commands = provider.commands();
        assert!(
            commands.is_empty(),
            "the root-provider host command must not appear in search — only its contributed rows (RootCommandProvider) should: {commands:?}"
        );
    }

    #[test]
    fn a_command_declaring_arguments_requires_one() {
        let provider = provider_with_an_argument_declaring_command();
        let commands = provider.commands();
        let greet = commands.iter().find(|c| c.id == "ext:demo:greet").unwrap();
        assert_eq!(greet.arguments.len(), 1);
        assert_eq!(greet.arguments[0].name, "name");
    }

    #[test]
    fn execute_rejects_unknown_and_malformed_ids_synchronously() {
        let provider = provider_with_one_installed_command();
        // Known command with no app handle: fails on the handle, meaning
        // validation passed.
        let err = provider.execute("ext:demo:search").unwrap_err();
        assert!(err.contains("app handle"), "unexpected error: {err}");

        assert!(provider.execute("ext:demo:missing").unwrap_err().contains("unknown"));
        assert!(provider.execute("firefox.desktop").unwrap_err().contains("not an extension command"));
    }

    #[test]
    fn execute_with_argument_validates_the_same_way_execute_does() {
        let provider = provider_with_an_argument_declaring_command();
        // Known command with no app handle: fails on the handle, same as
        // `execute` — proves `execute_with_argument` runs through the same
        // validation path rather than silently dropping the argument and
        // succeeding differently.
        let err = provider
            .execute_with_arguments("ext:demo:greet", &std::collections::HashMap::from([("name".to_string(), "Ada".to_string())]))
            .unwrap_err();
        assert!(err.contains("app handle"), "unexpected error: {err}");

        assert!(provider
            .execute_with_arguments("ext:demo:missing", &std::collections::HashMap::new())
            .unwrap_err()
            .contains("unknown"));
    }
}
