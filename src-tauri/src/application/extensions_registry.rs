use std::collections::HashMap;

use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::Error;
use crate::infrastructure::db::{SharedConnection, WithTransaction};
use crate::infrastructure::extension_host::protocol::{
    ArgumentType, ExportDeclaration, ExtensionManifest, ExtensionPreference, PreferenceType,
};

/// T28: clipboard-history became a real extension (seeded via
/// `register_builtin_extensions`'s manifest scan, not this list), but the
/// id string itself is still needed here — `lib.rs` ties the native
/// clipboard watcher's enabled state to it, and that id must match
/// whatever the `clipboard-history` extension's own manifest resolves to.
pub const CLIPBOARD_HISTORY_ID: &str = "clipboard-history";

/// T29: screenshots became a real extension too (seeded via
/// `register_builtin_extensions`'s manifest scan) — unlike clipboard-history
/// above, nothing native ties a live behavior to its id (no watcher to
/// toggle), so `SCREENSHOTS_ID` itself was deleted along with this entry.
///
/// T30: the last entry, `("navigation", "Navigation")`, is gone too —
/// menu-bar search (its only remaining reason to exist; switch-windows
/// already moved to its own `"switch-windows"` extension id in T19) is now
/// `extensions/menu-bar-search`. Confirmed before deleting that this toggle
/// had been fully inert since before this session (T19's own retrospective:
/// "the Settings 'Navigation' toggle has never actually hidden Switch
/// Windows" — nothing anywhere called `is_enabled("navigation")`), so this
/// isn't a functional regression, just removing a Settings → Extensions row
/// that already did nothing when flipped. Left as an empty slice rather
/// than deleting the seeding mechanism itself — a reusable "seed this
/// id/title into the extensions table as an enabled builtin" utility, not
/// dead code, even with nothing currently in it.
const BUILTIN_FEATURES: &[(&str, &str)] = &[];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionEntry {
    pub id: String,
    pub title: String,
    pub path: Option<String>,
    pub enabled: bool,
    pub description: Option<String>,
    pub source: String,
    /// The manifest's own `icon` (a `SYSTEM_ICON_NAMES` key, an emoji, or a
    /// path — resolved to absolute against `path` if it was relative, same
    /// convention as `script-commands`' own icon resolution on the JS
    /// side). `None` when the manifest declares none.
    pub icon: Option<String>,
    /// The manifest's `export` block, or `None` for an extension that
    /// doesn't opt into Import/Export. Read from storage rather than by
    /// running the extension, which is the whole point — the Settings pane
    /// lists categories without starting anything.
    pub export: Option<ExportDeclaration>,
}

/// Resolves a manifest icon string read back out of storage. A relative
/// image path (contains `.`, not already absolute) is joined against the
/// extension's install directory — `SYSTEM_ICON_NAMES` keys and emoji
/// never contain `.`, so this only ever fires for path-shaped values.
fn resolve_icon(icon: Option<String>, extension_path: Option<&str>) -> Option<String> {
    let icon = icon?;
    if !icon.contains('.') || std::path::Path::new(&icon).is_absolute() {
        return Some(icon);
    }
    match extension_path {
        Some(dir) => Some(std::path::Path::new(dir).join(&icon).to_string_lossy().into_owned()),
        None => Some(icon),
    }
}

/// Frontend-facing shape of a manifest `arguments[]` entry — mirrors
/// `PreferenceOptionRow`'s role for preferences: `ExtensionArgument` is the
/// manifest-parsing type, this is what actually reaches the API layer.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandArgument {
    pub name: String,
    #[serde(rename = "type")]
    pub argument_type: String,
    pub placeholder: Option<String>,
    pub required: bool,
    pub data: Option<Vec<PreferenceOptionRow>>,
}

fn argument_type_str(t: &ArgumentType) -> &'static str {
    match t {
        ArgumentType::Text => "text",
        ArgumentType::Password => "password",
        ArgumentType::Dropdown => "dropdown",
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledCommand {
    pub extension_id: String,
    pub name: String,
    pub title: String,
    pub subtitle: Option<String>,
    pub description: Option<String>,
    pub mode: String,
    pub keywords: Vec<String>,
    pub arguments: Vec<CommandArgument>,
    /// The owning extension's manifest-level icon (resolved), used as the
    /// fallback when this command has none of its own — see
    /// `ExtensionCommandProvider::commands()`.
    pub extension_icon: Option<String>,
}

/// Flattened, frontend-facing shape of a manifest `preferences[]` entry.
/// `command_name` is empty for an extension-level preference (applies to
/// every command), non-empty for one declared under a specific command.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreferenceDefinition {
    pub extension_id: String,
    pub command_name: String,
    pub name: String,
    pub preference_type: String,
    pub title: Option<String>,
    pub label: Option<String>,
    pub description: Option<String>,
    pub required: bool,
    pub default_value: Option<Value>,
    pub placeholder: Option<String>,
    pub data: Option<Vec<PreferenceOptionRow>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreferenceOptionRow {
    pub title: String,
    pub value: String,
}

fn preference_type_str(t: &PreferenceType) -> &'static str {
    match t {
        PreferenceType::Textfield => "textfield",
        PreferenceType::Password => "password",
        PreferenceType::Checkbox => "checkbox",
        PreferenceType::Dropdown => "dropdown",
        PreferenceType::AppPicker => "appPicker",
        PreferenceType::File => "file",
        PreferenceType::Directory => "directory",
    }
}

fn insert_preference_definitions(
    tx: &rusqlite::Transaction,
    extension_id: &str,
    command_name: &str,
    prefs: &[ExtensionPreference],
) -> Result<(), Error> {
    for pref in prefs {
        let default_value = pref.default.as_ref().map(|v| v.to_string());
        let data = pref.data.as_ref().map(|d| serde_json::to_string(d).unwrap_or_default());
        tx.execute(
            "INSERT INTO extension_preference_definitions
                (extension_id, command_name, name, preference_type, title, label, description, required, default_value, placeholder, data)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(extension_id, command_name, name) DO UPDATE SET
                preference_type = ?4, title = ?5, label = ?6, description = ?7, required = ?8, default_value = ?9, placeholder = ?10, data = ?11",
            params![
                extension_id,
                command_name,
                pref.name,
                preference_type_str(&pref.preference_type),
                pref.title,
                pref.label,
                pref.description,
                pref.required.unwrap_or(false) as i64,
                default_value,
                pref.placeholder,
                data,
            ],
        )?;
    }
    Ok(())
}

fn row_to_preference_definition(row: &rusqlite::Row) -> rusqlite::Result<PreferenceDefinition> {
    let default_value: Option<String> = row.get(8)?;
    let data: Option<String> = row.get(10)?;
    Ok(PreferenceDefinition {
        extension_id: row.get(0)?,
        command_name: row.get(1)?,
        name: row.get(2)?,
        preference_type: row.get(3)?,
        title: row.get(4)?,
        label: row.get(5)?,
        description: row.get(6)?,
        required: row.get::<_, i64>(7)? != 0,
        default_value: default_value.and_then(|s| serde_json::from_str(&s).ok()),
        placeholder: row.get(9)?,
        data: data.and_then(|s| serde_json::from_str(&s).ok()),
    })
}

pub struct ExtensionsRegistry {
    conn: SharedConnection,
    /// Bumped on every write to the `extensions`/`extension_commands`
    /// tables (`register_installed`, `unregister`, `set_enabled`) — see
    /// `CommandProvider::generation`'s doc comment. Also drives `list()`'s
    /// own cache below: `is_enabled()` is called once per feature gate
    /// on *every* search keystroke (`application::search::
    /// filter_by_enabled_features`, plus the notes toggle check in
    /// `api::search::search`) — 8+ separate queries a keystroke before
    /// this cache existed.
    generation: std::sync::atomic::AtomicU64,
    cached_list: std::sync::RwLock<Option<(u64, Vec<ExtensionEntry>)>>,
}

impl ExtensionsRegistry {
    pub fn new(conn: SharedConnection) -> Self {
        let registry = Self { conn, generation: std::sync::atomic::AtomicU64::new(0), cached_list: std::sync::RwLock::new(None) };
        registry.seed_builtins();
        registry
    }

    /// The `CommandProvider::generation` value `ExtensionCommandProvider`
    /// (a thin wrapper around this registry) reports to `CommandRegistry`.
    pub fn generation(&self) -> u64 {
        self.generation.load(std::sync::atomic::Ordering::SeqCst)
    }

    fn bump_generation(&self) {
        self.generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }

    fn seed_builtins(&self) {
        let conn = self.conn.lock().unwrap();
        for (id, title) in BUILTIN_FEATURES {
            let _ = conn.execute(
                "INSERT OR IGNORE INTO extensions (id, title, path, enabled, source) VALUES (?1, ?2, NULL, 1, 'builtin')",
                params![id, title],
            );
        }
    }

    fn query_list(&self) -> Vec<ExtensionEntry> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, title, path, enabled, description, source, icon, export_json FROM extensions ORDER BY title")
            .expect("valid query");
        let rows = stmt
            .query_map([], |row| {
                let path: Option<String> = row.get(2)?;
                let icon: Option<String> = row.get(6)?;
                // A declaration that fails to parse (hand-edited row, or
                // written by a newer build with a shape this one doesn't
                // understand) degrades to "this extension doesn't export"
                // rather than dropping the whole entry from the list.
                let export = row
                    .get::<_, Option<String>>(7)?
                    .and_then(|json| serde_json::from_str::<ExportDeclaration>(&json).ok());
                Ok(ExtensionEntry {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    enabled: row.get::<_, i64>(3)? != 0,
                    description: row.get(4)?,
                    source: row.get(5)?,
                    icon: resolve_icon(icon, path.as_deref()),
                    export,
                    path,
                })
            })
            .expect("valid query");
        rows.filter_map(Result::ok).collect()
    }

    pub fn list(&self) -> Vec<ExtensionEntry> {
        let current_generation = self.generation();
        if let Some((cached_generation, entries)) = self.cached_list.read().unwrap().as_ref() {
            if *cached_generation == current_generation {
                return entries.clone();
            }
        }
        let fresh = self.query_list();
        *self.cached_list.write().unwrap() = Some((current_generation, fresh.clone()));
        fresh
    }

    pub fn is_enabled(&self, id: &str) -> bool {
        self.list().into_iter().find(|e| e.id == id).map(|e| e.enabled).unwrap_or(true)
    }

    pub fn set_enabled(&self, id: &str, enabled: bool) -> Result<(), Error> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE extensions SET enabled = ?1 WHERE id = ?2",
            params![enabled as i64, id],
        )?;
        drop(conn);
        self.bump_generation();
        Ok(())
    }

    /// Registers (or replaces) an installed extension and its commands from
    /// a freshly-built manifest.
    pub fn register_installed(
        &self,
        id: &str,
        manifest: &ExtensionManifest,
        path: &str,
        source: &str,
    ) -> Result<(), Error> {
        self.conn.with_transaction(|tx| {
            let export_json = manifest
                .export
                .as_ref()
                .map(serde_json::to_string)
                .transpose()
                .map_err(|e| Error::msg(format!("extension '{id}' has an unserializable export declaration: {e}")))?;
            tx.execute(
                "INSERT INTO extensions (id, title, path, enabled, description, source, icon, export_json)
                 VALUES (?1, ?2, ?3, 1, ?4, ?5, ?6, ?7)
                 ON CONFLICT(id) DO UPDATE SET title = ?2, path = ?3, description = ?4, source = ?5, icon = ?6, export_json = ?7",
                params![id, manifest.title, path, manifest.description, source, manifest.icon, export_json],
            )?;

            tx.execute("DELETE FROM extension_commands WHERE extension_id = ?1", params![id])?;
            tx.execute(
                "DELETE FROM extension_preference_definitions WHERE extension_id = ?1",
                params![id],
            )?;

            for command in &manifest.commands {
                let mode = match command.mode {
                    crate::infrastructure::extension_host::protocol::CommandMode::View => "view",
                    crate::infrastructure::extension_host::protocol::CommandMode::NoView => "no-view",
                    crate::infrastructure::extension_host::protocol::CommandMode::MenuBar => "menu-bar",
                    crate::infrastructure::extension_host::protocol::CommandMode::RootProvider => "root-provider",
                };
                let keywords = command
                    .keywords
                    .as_ref()
                    .map(|k| k.join(","))
                    .unwrap_or_default();
                let arguments = command.arguments.as_ref().map(|args| {
                    let rows: Vec<CommandArgument> = args
                        .iter()
                        .map(|a| CommandArgument {
                            name: a.name.clone(),
                            argument_type: argument_type_str(&a.argument_type).to_string(),
                            placeholder: a.placeholder.clone(),
                            required: a.required,
                            data: a.data.as_ref().map(|d| d.iter().map(|o| PreferenceOptionRow { title: o.title.clone(), value: o.value.clone() }).collect()),
                        })
                        .collect();
                    serde_json::to_string(&rows).unwrap_or_default()
                });
                tx.execute(
                    "INSERT INTO extension_commands (extension_id, name, title, subtitle, description, mode, keywords, arguments)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    params![id, command.name, command.title, command.subtitle, command.description, mode, keywords, arguments],
                )?;

                if let Some(prefs) = &command.preferences {
                    insert_preference_definitions(tx, id, &command.name, prefs)?;
                }
            }

            if let Some(prefs) = &manifest.preferences {
                insert_preference_definitions(tx, id, "", prefs)?;
            }

            Ok(())
        })?;
        self.bump_generation();
        Ok(())
    }

    pub fn unregister(&self, id: &str) -> Result<(), Error> {
        self.conn.with_transaction(|tx| {
            tx.execute("DELETE FROM extension_commands WHERE extension_id = ?1", params![id])?;
            tx.execute(
                "DELETE FROM extension_preference_definitions WHERE extension_id = ?1",
                params![id],
            )?;
            tx.execute(
                "DELETE FROM extension_preference_values WHERE extension_id = ?1",
                params![id],
            )?;
            tx.execute("DELETE FROM extensions WHERE id = ?1", params![id])?;
            Ok(())
        })?;
        self.bump_generation();
        Ok(())
    }

    pub fn installed_commands(&self) -> Vec<InstalledCommand> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT ec.extension_id, ec.name, ec.title, ec.subtitle, ec.description, ec.mode, ec.keywords, ec.arguments, e.icon, e.path
                 FROM extension_commands ec
                 JOIN extensions e ON e.id = ec.extension_id
                 WHERE e.enabled = 1",
            )
            .expect("valid query");
        let rows = stmt
            .query_map([], |row| {
                let keywords: String = row.get(6)?;
                let arguments: Option<String> = row.get(7)?;
                let extension_icon: Option<String> = row.get(8)?;
                let extension_path: Option<String> = row.get(9)?;
                Ok(InstalledCommand {
                    extension_id: row.get(0)?,
                    name: row.get(1)?,
                    title: row.get(2)?,
                    subtitle: row.get(3)?,
                    description: row.get(4)?,
                    mode: row.get(5)?,
                    arguments: arguments.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default(),
                    keywords: if keywords.is_empty() {
                        Vec::new()
                    } else {
                        keywords.split(',').map(String::from).collect()
                    },
                    extension_icon: resolve_icon(extension_icon, extension_path.as_deref()),
                })
            })
            .expect("valid query");
        rows.filter_map(Result::ok).collect()
    }

    /// Every preference declared for `extension_id` — both extension-level
    /// (`command_name == ""`) and command-specific ones, across all
    /// commands. Callers filter by command themselves (see
    /// `resolve_preferences`) since the Settings UI wants to show all of
    /// them together.
    pub fn preference_definitions(&self, extension_id: &str) -> Vec<PreferenceDefinition> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT extension_id, command_name, name, preference_type, title, label, description, required, default_value, placeholder, data
                 FROM extension_preference_definitions WHERE extension_id = ?1
                 ORDER BY command_name, name",
            )
            .expect("valid query");
        let rows = stmt.query_map(params![extension_id], row_to_preference_definition).expect("valid query");
        rows.filter_map(Result::ok).collect()
    }

    pub fn preference_values(&self, extension_id: &str) -> HashMap<String, Value> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT name, value FROM extension_preference_values WHERE extension_id = ?1")
            .expect("valid query");
        let rows = stmt
            .query_map(params![extension_id], |row| {
                let name: String = row.get(0)?;
                let raw: String = row.get(1)?;
                Ok((name, raw))
            })
            .expect("valid query");
        rows.filter_map(Result::ok)
            .filter_map(|(name, raw)| serde_json::from_str::<Value>(&raw).ok().map(|v| (name, v)))
            .collect()
    }

    pub fn set_preference_value(&self, extension_id: &str, name: &str, value: &Value) -> Result<(), Error> {
        let conn = self.conn.lock().unwrap();
        let raw = value.to_string();
        conn.execute(
            "INSERT INTO extension_preference_values (extension_id, name, value) VALUES (?1, ?2, ?3)
             ON CONFLICT(extension_id, name) DO UPDATE SET value = ?3",
            params![extension_id, name, raw],
        )?;
        Ok(())
    }

    /// Preference values a command should actually run with: stored values
    /// take priority, falling back to each definition's manifest default.
    /// Returns the names of any *required* preference that has neither —
    /// matching real Raycast's behavior of gating a command's first run on
    /// its required preferences being configured.
    pub fn resolve_preferences(&self, extension_id: &str, command_name: &str) -> Result<HashMap<String, Value>, Vec<String>> {
        let definitions = self.preference_definitions(extension_id);
        let stored = self.preference_values(extension_id);
        let mut resolved = HashMap::new();
        let mut missing = Vec::new();

        for def in definitions.iter().filter(|d| d.command_name.is_empty() || d.command_name == command_name) {
            if let Some(value) = stored.get(&def.name) {
                resolved.insert(def.name.clone(), value.clone());
            } else if let Some(default) = &def.default_value {
                resolved.insert(def.name.clone(), default.clone());
            } else if def.required {
                missing.push(def.name.clone());
            }
        }

        if missing.is_empty() {
            Ok(resolved)
        } else {
            Err(missing)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::extension_host::protocol::{CommandMode, ExtensionCommandManifest};
    use rusqlite::Connection;
    use std::sync::{Arc, Mutex};

    fn test_registry() -> ExtensionsRegistry {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE extensions (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                path TEXT,
                enabled INTEGER NOT NULL DEFAULT 1,
                command_alias TEXT,
                command_hotkey TEXT,
                description TEXT,
                source TEXT NOT NULL DEFAULT 'builtin',
                icon TEXT,
                export_json TEXT
            );
            CREATE TABLE extension_commands (
                extension_id TEXT NOT NULL,
                name TEXT NOT NULL,
                title TEXT NOT NULL,
                subtitle TEXT,
                description TEXT,
                mode TEXT NOT NULL,
                keywords TEXT,
                arguments TEXT,
                PRIMARY KEY (extension_id, name)
            );
            CREATE TABLE extension_preference_definitions (
                extension_id TEXT NOT NULL,
                command_name TEXT NOT NULL DEFAULT '',
                name TEXT NOT NULL,
                preference_type TEXT NOT NULL,
                title TEXT,
                label TEXT,
                description TEXT,
                required INTEGER NOT NULL DEFAULT 0,
                default_value TEXT,
                placeholder TEXT,
                data TEXT,
                PRIMARY KEY (extension_id, command_name, name)
            );
            CREATE TABLE extension_preference_values (
                extension_id TEXT NOT NULL,
                name TEXT NOT NULL,
                value TEXT NOT NULL,
                PRIMARY KEY (extension_id, name)
            );",
        )
        .unwrap();
        ExtensionsRegistry::new(Arc::new(Mutex::new(conn)))
    }

    fn fake_manifest() -> ExtensionManifest {
        ExtensionManifest {
            name: "demo".into(),
            title: "Demo".into(),
            description: Some("a demo extension".into()),
            icon: None,
            author: None,
            categories: None,
            commands: vec![
                ExtensionCommandManifest {
                    name: "search".into(),
                    title: "Search Demo".into(),
                    subtitle: Some("Demo".into()),
                    description: None,
                    mode: CommandMode::View,
                    icon: None,
                    keywords: Some(vec!["demo".into(), "search".into()]),
                    preferences: None,
                    arguments: None,
                },
                ExtensionCommandManifest {
                    name: "quick-action".into(),
                    title: "Quick Action".into(),
                    subtitle: None,
                    description: None,
                    mode: CommandMode::NoView,
                    icon: None,
                    keywords: None,
                    preferences: None,
                    arguments: None,
                },
            ],
            preferences: None,
                    export: None,
        }
    }

    // `seeds_builtins_as_enabled` (asserted `BUILTIN_FEATURES` seeds each
    // entry as enabled/`source: "builtin"`) removed here — T30 emptied
    // `BUILTIN_FEATURES` (Navigation was its last entry), so this test
    // would only ever exercise a `for` loop over nothing. Restore an
    // equivalent test if `BUILTIN_FEATURES` ever gains an entry again.

    #[test]
    fn register_installed_round_trips_an_export_declaration() {
        let registry = test_registry();
        let mut manifest = fake_manifest();
        manifest.export = Some(ExportDeclaration {
            title: "Demo Data".into(),
            description: Some("Everything Demo saved".into()),
            entry: None,
        });

        registry.register_installed("demo", &manifest, "/tmp/demo", "installed").unwrap();

        let entry = registry.list().into_iter().find(|e| e.id == "demo").unwrap();
        let export = entry.export.expect("declaration must survive the write/read round trip");
        assert_eq!(export.title, "Demo Data");
        assert_eq!(export.description.as_deref(), Some("Everything Demo saved"));
        assert_eq!(export.entry_name(), ExportDeclaration::DEFAULT_ENTRY, "an absent entry defaults to \"export\"");
    }

    #[test]
    fn an_extension_declaring_no_export_reads_back_as_none() {
        let registry = test_registry();
        registry.register_installed("demo", &fake_manifest(), "/tmp/demo", "installed").unwrap();

        let entry = registry.list().into_iter().find(|e| e.id == "demo").unwrap();
        assert!(entry.export.is_none());
    }

    #[test]
    fn a_declared_entry_overrides_the_default() {
        let registry = test_registry();
        let mut manifest = fake_manifest();
        manifest.export =
            Some(ExportDeclaration { title: "Demo Data".into(), description: None, entry: Some("backup".into()) });

        registry.register_installed("demo", &manifest, "/tmp/demo", "installed").unwrap();

        let entry = registry.list().into_iter().find(|e| e.id == "demo").unwrap();
        assert_eq!(entry.export.unwrap().entry_name(), "backup");
    }

    #[test]
    fn register_installed_persists_extension_and_commands() {
        let registry = test_registry();
        registry
            .register_installed("demo", &fake_manifest(), "/tmp/demo", "installed")
            .unwrap();

        let entry = registry.list().into_iter().find(|e| e.id == "demo").unwrap();
        assert_eq!(entry.title, "Demo");
        assert_eq!(entry.description.as_deref(), Some("a demo extension"));
        assert_eq!(entry.source, "installed");

        let commands = registry.installed_commands();
        let demo_commands: Vec<_> = commands.iter().filter(|c| c.extension_id == "demo").collect();
        assert_eq!(demo_commands.len(), 2);
        let search = demo_commands.iter().find(|c| c.name == "search").unwrap();
        assert_eq!(search.keywords, vec!["demo".to_string(), "search".to_string()]);
    }

    #[test]
    fn register_installed_round_trips_a_system_icon_name() {
        let registry = test_registry();
        let mut manifest = fake_manifest();
        manifest.icon = Some("camera".into());
        registry.register_installed("demo", &manifest, "/tmp/demo", "installed").unwrap();

        let entry = registry.list().into_iter().find(|e| e.id == "demo").unwrap();
        assert_eq!(entry.icon.as_deref(), Some("camera"));

        let commands = registry.installed_commands();
        let search = commands.iter().find(|c| c.extension_id == "demo" && c.name == "search").unwrap();
        assert_eq!(search.extension_icon.as_deref(), Some("camera"));
    }

    #[test]
    fn register_installed_resolves_a_relative_icon_path_against_the_extension_dir() {
        let registry = test_registry();
        let mut manifest = fake_manifest();
        manifest.icon = Some("icon.png".into());
        registry.register_installed("demo", &manifest, "/tmp/demo", "installed").unwrap();

        let entry = registry.list().into_iter().find(|e| e.id == "demo").unwrap();
        assert_eq!(entry.icon.as_deref(), Some("/tmp/demo/icon.png"));
    }

    #[test]
    fn register_installed_leaves_an_absolute_icon_path_untouched() {
        let registry = test_registry();
        let mut manifest = fake_manifest();
        manifest.icon = Some("/opt/icons/demo.png".into());
        registry.register_installed("demo", &manifest, "/tmp/demo", "installed").unwrap();

        let entry = registry.list().into_iter().find(|e| e.id == "demo").unwrap();
        assert_eq!(entry.icon.as_deref(), Some("/opt/icons/demo.png"));
    }

    #[test]
    fn register_installed_is_idempotent_on_reinstall() {
        let registry = test_registry();
        registry.register_installed("demo", &fake_manifest(), "/tmp/demo", "installed").unwrap();
        registry.register_installed("demo", &fake_manifest(), "/tmp/demo-v2", "installed").unwrap();

        assert_eq!(registry.list().iter().filter(|e| e.id == "demo").count(), 1);
        assert_eq!(registry.installed_commands().iter().filter(|c| c.extension_id == "demo").count(), 2);
        let entry = registry.list().into_iter().find(|e| e.id == "demo").unwrap();
        assert_eq!(entry.path.as_deref(), Some("/tmp/demo-v2"));
    }

    /// Regression test for `list()`'s generation-tagged cache (T34,
    /// `plans/refactor-extension-platform.md`): `is_enabled` — called
    /// once per feature gate on every search keystroke — must never
    /// serve a stale value after `set_enabled` writes a new one, even
    /// though `list()` no longer re-queries SQLite on every call.
    #[test]
    fn is_enabled_reflects_set_enabled_immediately_despite_the_list_cache() {
        let registry = test_registry();
        registry.register_installed("demo", &fake_manifest(), "/tmp/demo", "installed").unwrap();
        assert!(registry.is_enabled("demo"));

        // Warm the cache with a couple of reads before the write, like
        // several feature-gate checks in one search call would.
        registry.is_enabled("demo");
        registry.is_enabled("demo");

        registry.set_enabled("demo", false).unwrap();
        assert!(!registry.is_enabled("demo"), "must see the new value immediately, not the cached pre-write one");

        registry.set_enabled("demo", true).unwrap();
        assert!(registry.is_enabled("demo"), "must see a second write's value too, not just the first");
    }

    #[test]
    fn installed_commands_excludes_disabled_extensions() {
        let registry = test_registry();
        registry.register_installed("demo", &fake_manifest(), "/tmp/demo", "installed").unwrap();
        registry.set_enabled("demo", false).unwrap();

        assert!(registry.installed_commands().iter().all(|c| c.extension_id != "demo"));
    }

    #[test]
    fn unregister_removes_extension_and_its_commands() {
        let registry = test_registry();
        registry.register_installed("demo", &fake_manifest(), "/tmp/demo", "installed").unwrap();
        registry.unregister("demo").unwrap();

        assert!(registry.list().iter().all(|e| e.id != "demo"));
        assert!(registry.installed_commands().is_empty());
    }

    fn manifest_with_preferences() -> ExtensionManifest {
        let mut manifest = fake_manifest();
        manifest.preferences = Some(vec![ExtensionPreference {
            name: "apiToken".into(),
            preference_type: PreferenceType::Password,
            title: Some("API Token".into()),
            label: None,
            description: None,
            required: Some(true),
            default: None,
            placeholder: Some("sk-...".into()),
            data: None,
        }]);
        manifest.commands[0].preferences = Some(vec![ExtensionPreference {
            name: "resultLimit".into(),
            preference_type: PreferenceType::Textfield,
            title: Some("Result Limit".into()),
            label: None,
            description: None,
            required: Some(false),
            default: Some(Value::String("10".into())),
            placeholder: None,
            data: None,
        }]);
        manifest
    }

    #[test]
    fn register_installed_persists_preference_definitions() {
        let registry = test_registry();
        registry.register_installed("demo", &manifest_with_preferences(), "/tmp/demo", "installed").unwrap();

        let defs = registry.preference_definitions("demo");
        assert_eq!(defs.len(), 2);
        assert!(defs.iter().any(|d| d.name == "apiToken" && d.command_name.is_empty() && d.required));
        assert!(defs.iter().any(|d| d.name == "resultLimit" && d.command_name == "search" && !d.required));
    }

    #[test]
    fn register_installed_replaces_preference_definitions_on_reinstall() {
        let registry = test_registry();
        registry.register_installed("demo", &manifest_with_preferences(), "/tmp/demo", "installed").unwrap();
        registry.register_installed("demo", &fake_manifest(), "/tmp/demo", "installed").unwrap();

        assert!(registry.preference_definitions("demo").is_empty());
    }

    #[test]
    fn resolve_preferences_falls_back_to_manifest_default() {
        let registry = test_registry();
        registry.register_installed("demo", &manifest_with_preferences(), "/tmp/demo", "installed").unwrap();
        registry.set_preference_value("demo", "apiToken", &Value::String("secret".into())).unwrap();

        let resolved = registry.resolve_preferences("demo", "search").unwrap();
        assert_eq!(resolved.get("apiToken"), Some(&Value::String("secret".into())));
        assert_eq!(resolved.get("resultLimit"), Some(&Value::String("10".into())));
    }

    #[test]
    fn resolve_preferences_prefers_stored_value_over_default() {
        let registry = test_registry();
        registry.register_installed("demo", &manifest_with_preferences(), "/tmp/demo", "installed").unwrap();
        registry.set_preference_value("demo", "apiToken", &Value::String("secret".into())).unwrap();
        registry.set_preference_value("demo", "resultLimit", &Value::String("25".into())).unwrap();

        let resolved = registry.resolve_preferences("demo", "search").unwrap();
        assert_eq!(resolved.get("resultLimit"), Some(&Value::String("25".into())));
    }

    #[test]
    fn resolve_preferences_gates_on_missing_required_preference() {
        let registry = test_registry();
        registry.register_installed("demo", &manifest_with_preferences(), "/tmp/demo", "installed").unwrap();

        let err = registry.resolve_preferences("demo", "search").unwrap_err();
        assert_eq!(err, vec!["apiToken".to_string()]);
    }

    #[test]
    fn resolve_preferences_excludes_other_commands_preferences() {
        let registry = test_registry();
        registry.register_installed("demo", &manifest_with_preferences(), "/tmp/demo", "installed").unwrap();
        registry.set_preference_value("demo", "apiToken", &Value::String("secret".into())).unwrap();

        let resolved = registry.resolve_preferences("demo", "quick-action").unwrap();
        assert!(!resolved.contains_key("resultLimit"));
    }

    #[test]
    fn unregister_removes_preference_definitions_and_values() {
        let registry = test_registry();
        registry.register_installed("demo", &manifest_with_preferences(), "/tmp/demo", "installed").unwrap();
        registry.set_preference_value("demo", "apiToken", &Value::String("secret".into())).unwrap();
        registry.unregister("demo").unwrap();

        assert!(registry.preference_definitions("demo").is_empty());
        assert!(registry.preference_values("demo").is_empty());
    }
}
