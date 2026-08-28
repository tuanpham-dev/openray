//! T14: dynamic root-search contribution.
//!
//! A `root-provider`-mode extension command exports a plain listing
//! function — `export default async function(): Promise<RootCommand[]>`
//! — instead of a React component. No mounting, no reconciler involved at
//! all: `runner.ts` requires the module and calls the default export
//! directly, once, and is done — which is also why "zero timers while
//! idle" is close to free: nothing stays resident afterward to leak one
//! (an extension author who starts a timer inside that function anyway is
//! misusing the mode, not something this module can prevent structurally,
//! same as any other headless command).
//!
//! Row activation is a second, named export — `export async function
//! execute(id, argument?): Promise<void>` — reached through the *same*
//! id resolution `ExtensionCommandProvider` already uses for static
//! manifest commands (`ext:{extensionId}:{name}`, see
//! `extension_commands::parse_extension_command_id`): a contributed row's
//! id is `ext:{extensionId}:{opaqueRowId}`, and `extension_commands::
//! launch` falls back to this module when `{opaqueRowId}` doesn't name a
//! real manifest command. This is why `run_extension_command` (the
//! palette-click path) and `ExtensionCommandProvider::execute` (the
//! hotkey path) both need no changes to reach a contributed row
//! correctly — they already funnel through `launch`.
//!
//! Contributed rows carry two flags no static `Command` field expresses —
//! `needs_confirm`/`opens_view` — kept in a side-table here rather than
//! added to `Command` itself, matching this refactor's established
//! precedent (T7's `FeatureGate`, `system_commands::CONFIRM_COMMAND_IDS`):
//! `Command { ... }` has 80+ construction sites across code this plan is
//! actively migrating away from; a struct field would touch all of them
//! for two flags only dynamic rows ever set. `hotkey_dispatch::classify`
//! and `api::search`'s row-building both consult `flags_for` instead.
//!
//! One root-provider command per extension is assumed for v1 — every
//! Phase 4 consumer (quicklinks, snippets, scripts, …) only ever needs
//! one. `set_rows` replaces an extension's entire contribution wholesale
//! each time it's called (the initial push at host start, or a later one
//! triggered by the extension's own `refreshRootCommands()`).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use tauri::AppHandle;

use crate::domain::command::{Command, CommandKind};
use crate::domain::ports::CommandProvider;
use crate::infrastructure::extension_host::protocol::RootCommand;

fn full_id(extension_id: &str, row_id: &str) -> String {
    format!("ext:{extension_id}:{row_id}")
}

struct RootCommandRow {
    command: Command,
    needs_confirm: bool,
    opens_view: bool,
}

struct ExtensionRows {
    /// The manifest command name whose listing function produced these
    /// rows — where activation routes back to.
    host_command_name: String,
    rows: Vec<RootCommandRow>,
    /// T21: whether this extension's root-provider module exports
    /// `onQuery` — computed Node-side (`runner.ts::runRootProviderList`,
    /// a plain `typeof exports.onQuery === 'function'` check) and pushed
    /// alongside the listing itself, rather than added as a manifest
    /// field: it's a fact about the module's actual exports, the same
    /// kind of thing `opens_view`/`needs_confirm` already are per-row.
    supports_inline_query: bool,
}

pub struct RootCommandProvider {
    by_extension: Mutex<HashMap<String, ExtensionRows>>,
    generation: AtomicU64,
    /// Absent only in tests — executing needs the running app, same
    /// convention as `ExtensionCommandProvider`.
    app: Option<AppHandle>,
}

impl RootCommandProvider {
    pub fn new(app: AppHandle) -> Self {
        Self { by_extension: Mutex::new(HashMap::new()), generation: AtomicU64::new(0), app: Some(app) }
    }

    #[cfg(test)]
    pub fn new_for_tests() -> Self {
        Self { by_extension: Mutex::new(HashMap::new()), generation: AtomicU64::new(0), app: None }
    }

    /// Replaces one extension's contributed rows wholesale. `extension_icon`
    /// is the owning extension's own manifest icon (looked up by the
    /// caller, `extension_bridge::root_commands_pushed`), used as the
    /// fallback for any row that doesn't set its own `icon`.
    pub fn set_rows(
        &self,
        extension_id: &str,
        host_command_name: &str,
        supports_inline_query: bool,
        extension_icon: Option<String>,
        incoming: Vec<RootCommand>,
    ) {
        let rows = incoming
            .into_iter()
            .map(|r| RootCommandRow {
                command: Command {
                    id: full_id(extension_id, &r.id),
                    title: r.title,
                    subtitle: r.subtitle,
                    icon: r.icon.or_else(|| extension_icon.clone()),
                    kind: CommandKind::ExtensionCommand,
                    keywords: r.keywords,
                    // A root-provider row declares only *that* it wants an
                    // argument, not a manifest entry describing one — so it
                    // gets a single required text field.
                    arguments: if r.requires_argument {
                        vec![crate::domain::command::CommandArgument {
                            name: "argument".to_string(),
                            argument_type: "text".to_string(),
                            placeholder: None,
                            required: true,
                            data: None,
                        }]
                    } else {
                        Vec::new()
                    },
                },
                needs_confirm: r.needs_confirm,
                opens_view: r.opens_view,
            })
            .collect();
        self.by_extension.lock().unwrap().insert(
            extension_id.to_string(),
            ExtensionRows { host_command_name: host_command_name.to_string(), rows, supports_inline_query },
        );
        self.generation.fetch_add(1, Ordering::SeqCst);
    }

    /// `(extension_id, host_command_name)` for every extension whose
    /// root-provider module exports `onQuery` — `inline_query::dispatch`'s
    /// fan-out list. Order is whatever `HashMap` iteration happens to
    /// yield; callers merge results as one unordered set, so this is fine.
    pub fn inline_capable_commands(&self) -> Vec<(String, String)> {
        self.by_extension
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, rows)| rows.supports_inline_query)
            .map(|(extension_id, rows)| (extension_id.clone(), rows.host_command_name.clone()))
            .collect()
    }

    /// The `root-provider` command name currently registered for
    /// `extension_id`, if its listing has pushed at least once —
    /// `refreshRootCommands()`'s handler uses this (it knows only the
    /// calling extension, not which specific row prompted the refresh).
    pub fn host_command_name(&self, extension_id: &str) -> Option<String> {
        self.by_extension.lock().unwrap().get(extension_id).map(|rows| rows.host_command_name.clone())
    }

    /// The manifest command name whose listing function contributed a
    /// row with this exact `(extension_id, row_id)` pair, if any — `None`
    /// means it isn't (currently) a known contributed row, which callers
    /// should read as "not a root-provider row" (either a real manifest
    /// command, or an extension whose listing hasn't pushed yet).
    pub fn host_command_name_for(&self, extension_id: &str, row_id: &str) -> Option<String> {
        let full = full_id(extension_id, row_id);
        let by_extension = self.by_extension.lock().unwrap();
        let rows = by_extension.get(extension_id)?;
        rows.rows.iter().any(|r| r.command.id == full).then(|| rows.host_command_name.clone())
    }

    /// `(extension_id, host_command_name)` for whichever extension
    /// contributed a row with this exact `Command.id` — used by
    /// `spawn_launch`, which only has the full id, not the split form.
    fn host_command_for(&self, command_id: &str) -> Option<(String, String)> {
        self.by_extension.lock().unwrap().iter().find_map(|(extension_id, rows)| {
            rows.rows.iter().any(|r| r.command.id == command_id).then(|| (extension_id.clone(), rows.host_command_name.clone()))
        })
    }

    /// Drops every row `extension_id` has ever contributed — the disable-time
    /// counterpart to `set_rows`. Without this, disabling a root-provider
    /// extension mid-session leaves its last-pushed rows resident here: the
    /// `enabled=1` SQL filter that hides a disabled extension's *static*
    /// commands (`extensions_registry::installed_commands`) has nothing to
    /// do with this in-memory map, and nothing else ever calls it. A no-op
    /// (correctly) if the extension never pushed rows, e.g. it isn't a
    /// root-provider extension at all — `HashMap::remove` on a missing key
    /// only bumps the generation if something was actually removed, so
    /// disabling a non-root-provider extension doesn't force a needless
    /// search-cache invalidation.
    pub fn clear_extension(&self, extension_id: &str) {
        let removed = self.by_extension.lock().unwrap().remove(extension_id).is_some();
        if removed {
            self.generation.fetch_add(1, Ordering::SeqCst);
        }
    }

    /// `(needs_confirm, opens_view)` for a contributed row, if known.
    pub fn flags_for(&self, command_id: &str) -> Option<(bool, bool)> {
        self.by_extension
            .lock()
            .unwrap()
            .values()
            .find_map(|rows| rows.rows.iter().find(|r| r.command.id == command_id).map(|r| (r.needs_confirm, r.opens_view)))
    }
}

impl CommandProvider for RootCommandProvider {
    fn commands(&self) -> Vec<Command> {
        self.by_extension.lock().unwrap().values().flat_map(|rows| rows.rows.iter().map(|r| r.command.clone())).collect()
    }

    /// Mirrors `ExtensionCommandProvider::execute` exactly — both are
    /// thin fire-and-forget wrappers around `extension_commands::launch`,
    /// which is where the real "static command vs. contributed row"
    /// resolution happens (see this module's doc comment).
    fn execute(&self, command_id: &str) -> Result<(), String> {
        self.spawn_launch(command_id, std::collections::HashMap::new())
    }

    fn execute_with_arguments(
        &self,
        command_id: &str,
        arguments: &std::collections::HashMap<String, String>,
    ) -> Result<(), String> {
        self.spawn_launch(command_id, arguments.clone())
    }

    fn generation(&self) -> Option<u64> {
        Some(self.generation.load(Ordering::SeqCst))
    }
}

impl RootCommandProvider {
    fn spawn_launch(&self, command_id: &str, arguments: std::collections::HashMap<String, String>) -> Result<(), String> {
        let (extension_id, _) =
            self.host_command_for(command_id).ok_or_else(|| format!("unknown root-provider row '{command_id}'"))?;
        let app = self.app.clone().ok_or("root-provider rows can't run without an app handle")?;
        let command_id = command_id.to_string();

        tauri::async_runtime::spawn(async move {
            // `command_name` here is the row's own opaque id, not a real
            // manifest command — `launch`'s fallback (see its doc
            // comment) resolves it back to the host command.
            let Some((_, name)) = crate::application::extension_commands::parse_extension_command_id(&command_id) else {
                log::warn!("root-provider row id '{command_id}' doesn't parse as an extension command id");
                return;
            };
            if let Err(e) = crate::application::extension_commands::launch(&app, &extension_id, name, &arguments).await {
                log::warn!("root-provider row '{command_id}' failed: {e}");
            }
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, needs_confirm: bool, opens_view: bool) -> RootCommand {
        RootCommand {
            id: id.into(),
            title: id.into(),
            subtitle: None,
            icon: None,
            keywords: vec![],
            requires_argument: false,
            needs_confirm,
            opens_view,
        }
    }

    #[test]
    fn set_rows_namespaces_ids_and_bumps_generation() {
        let provider = RootCommandProvider::new_for_tests();
        assert_eq!(provider.generation(), Some(0));

        provider.set_rows("quicklinks", "list", false, None, vec![row("abc123", false, false)]);
        let commands = provider.commands();
        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0].id, "ext:quicklinks:abc123");
        assert_eq!(commands[0].kind, CommandKind::ExtensionCommand);
        assert_eq!(provider.generation(), Some(1));
    }

    #[test]
    fn set_rows_falls_back_to_the_extension_icon_only_for_rows_without_their_own() {
        let provider = RootCommandProvider::new_for_tests();
        let mut with_own_icon = row("has-icon", false, false);
        with_own_icon.icon = Some("sparkles".into());

        provider.set_rows(
            "quicklinks",
            "list",
            false,
            Some("link".into()),
            vec![row("no-icon", false, false), with_own_icon],
        );

        let commands = provider.commands();
        let no_icon = commands.iter().find(|c| c.id == "ext:quicklinks:no-icon").unwrap();
        let has_icon = commands.iter().find(|c| c.id == "ext:quicklinks:has-icon").unwrap();
        assert_eq!(no_icon.icon.as_deref(), Some("link"));
        assert_eq!(has_icon.icon.as_deref(), Some("sparkles"));
    }

    #[test]
    fn set_rows_replaces_the_extensions_previous_rows_wholesale() {
        let provider = RootCommandProvider::new_for_tests();
        provider.set_rows("quicklinks", "list", false, None, vec![row("a", false, false), row("b", false, false)]);
        provider.set_rows("quicklinks", "list", false, None, vec![row("c", false, false)]);

        let ids: Vec<String> = provider.commands().into_iter().map(|c| c.id).collect();
        assert_eq!(ids, vec!["ext:quicklinks:c".to_string()]);
    }

    #[test]
    fn host_command_for_resolves_a_known_row_and_none_for_an_unknown_one() {
        let provider = RootCommandProvider::new_for_tests();
        provider.set_rows("quicklinks", "list", false, None, vec![row("abc123", false, false)]);

        assert_eq!(provider.host_command_for("ext:quicklinks:abc123"), Some(("quicklinks".to_string(), "list".to_string())));
        assert_eq!(provider.host_command_for("ext:quicklinks:missing"), None);
    }

    #[test]
    fn host_command_name_for_resolves_the_split_id_form() {
        let provider = RootCommandProvider::new_for_tests();
        provider.set_rows("quicklinks", "list", false, None, vec![row("abc123", false, false)]);

        assert_eq!(provider.host_command_name_for("quicklinks", "abc123"), Some("list".to_string()));
        assert_eq!(provider.host_command_name_for("quicklinks", "missing"), None);
        assert_eq!(provider.host_command_name_for("no-such-extension", "abc123"), None);
    }

    #[test]
    fn flags_for_reflects_needs_confirm_and_opens_view_per_row() {
        let provider = RootCommandProvider::new_for_tests();
        provider.set_rows(
            "system",
            "list",
            false,
            None, vec![row("shut-down", true, true), row("lock-screen", false, false)],
        );

        assert_eq!(provider.flags_for("ext:system:shut-down"), Some((true, true)));
        assert_eq!(provider.flags_for("ext:system:lock-screen"), Some((false, false)));
        assert_eq!(provider.flags_for("ext:system:missing"), None);
    }

    #[test]
    fn inline_capable_commands_lists_only_extensions_flagged_as_supporting_it() {
        let provider = RootCommandProvider::new_for_tests();
        provider.set_rows("quicklinks", "list", false, None, vec![row("a", false, false)]);
        provider.set_rows("translate", "list", true, None, vec![row("b", false, false)]);

        assert_eq!(provider.inline_capable_commands(), vec![("translate".to_string(), "list".to_string())]);
    }

    #[test]
    fn clear_extension_drops_its_rows_and_bumps_generation_only_if_it_had_any() {
        let provider = RootCommandProvider::new_for_tests();
        provider.set_rows("quicklinks", "list", false, None, vec![row("abc123", false, false)]);
        assert_eq!(provider.generation(), Some(1));

        provider.clear_extension("no-such-extension");
        assert_eq!(provider.generation(), Some(1), "clearing an extension with no rows shouldn't bump generation");

        provider.clear_extension("quicklinks");
        assert!(provider.commands().is_empty());
        assert_eq!(provider.generation(), Some(2));
        assert_eq!(provider.host_command_name("quicklinks"), None);
    }

    #[test]
    fn execute_rejects_an_unknown_row_without_an_app_handle() {
        let provider = RootCommandProvider::new_for_tests();
        let err = provider.execute("ext:quicklinks:missing").unwrap_err();
        assert!(err.contains("unknown root-provider row"), "unexpected error: {err}");
    }
}
