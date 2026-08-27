//! T21: per-keystroke inline rows contributed by a `root-provider`
//! command's optional `onQuery(query, context) -> InlineRow | null` export
//! — the mechanism T22 (translate) and T23 (calculator) migrate onto,
//! replacing `SearchResponse`'s hardcoded `calculator`/`translationIntent`/
//! `noteCapture` fields one feature at a time as each one actually moves.
//!
//! Deliberately **off** `search()`'s synchronous return path: `search()`
//! already has to stay fast (T2/T33's cached-provider latency budget), and
//! an inline provider does a real cross-process round trip to Node — see
//! `dispatch`'s doc comment for how staleness is handled instead of ever
//! blocking on it.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

use futures_util::future::join_all;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

use crate::application::state::AppState;

pub const INLINE_ROWS_EVENT: &str = "inline-rows";

/// One row an inline-capable `root-provider` command's `onQuery` export
/// returned for the query that was live when it replied. `value`, if
/// present, is what activating the row (Enter) copies to the clipboard —
/// deliberately client-side-only (no second RPC round trip to activate),
/// since every inline provider built so far (T22's translate; T23's
/// calculator) only ever needs "show a live-computed answer, Enter (or a
/// keyboard-shortcut variant) copies it". Every field here is opaque to
/// Rust — it only validates the shape and passes rows through to the
/// frontend, never reads or acts on their content itself.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InlineRow {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    /// T23: an alternate, unformatted form of `value` — backs a
    /// secondary-action copy variant (native calculator's ⌘Enter "Copy
    /// Unformatted Answer"). `None` means that variant falls back to
    /// `value` — see `App.tsx`'s inline-row `onActivate` branch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value_raw: Option<String>,
    /// T26: an "activatable" row — set together with `argument`, mutually
    /// exclusive with `value`/`value_raw` in practice (every row built so
    /// far is one shape or the other, never both; nothing enforces that at
    /// the type level since the two shapes share nothing structural to
    /// gate on). When present, `App.tsx`'s inline-row `onActivate` runs the
    /// extension's own `command_name` command (with `argument`) via the
    /// same `run_extension_command` path any manifest command launch
    /// already goes through, instead of copying `value` to the clipboard —
    /// notes' quick-capture row is the first (and so far only) row shaped
    /// this way, since "create a note from this text" has no sensible
    /// clipboard-copy reading. Extension-supplied; never a manifest
    /// command's own launch identity, just its name within this
    /// extension.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command_name: Option<String>,
    /// Set by `dispatch` itself once a reply's `command_name` is present —
    /// never trusted from the extension's own reply, since Rust already
    /// knows authoritatively which extension this row came from (the same
    /// `extension_id` `dispatch`'s own target loop is keyed on).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extension_id: Option<String>,
    /// The argument-bar-shaped value `command_name`'s launch carries —
    /// e.g. quick-capture's captured text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub argument: Option<String>,
    /// Opts into the large Raycast-style result card instead of a plain
    /// list row. Only recognized value is `"card"`; anything else (or
    /// absent) renders the plain row — opaque to Rust like every other
    /// field here, just passed through to the frontend.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display: Option<String>,
    /// Heading shown above the card (e.g. "Calculator", "Translate to
    /// German"). Only meaningful when `display` is `"card"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub section_label: Option<String>,
    /// Left half of the card. When absent, the frontend renders `icon`
    /// there instead and skips the divider/arrow between halves.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub card_left: Option<String>,
    /// Right half of the card; the frontend falls back to `title` when
    /// absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub card_right: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct InlineRowsPayload {
    rows: Vec<InlineRow>,
}

/// Tracks the most recently *dispatched* query so an earlier, slower
/// `onQuery` round trip can be dropped on arrival instead of clobbering a
/// newer, already-settled one's rows once it finally replies — the "stale
/// in-flight results are dropped by request id" requirement, with fast
/// typing doing one *emitted* unit of work per settled query rather than
/// per keystroke. A single global counter (not per-extension) is correct
/// because a query's inline-rows section is always replaced as one unit,
/// mirroring how `search()` itself replaces the whole commands list per
/// call rather than patching it incrementally.
pub struct InlineQueryDispatcher {
    latest: AtomicU64,
}

impl Default for InlineQueryDispatcher {
    fn default() -> Self {
        Self::new()
    }
}

impl InlineQueryDispatcher {
    pub fn new() -> Self {
        Self { latest: AtomicU64::new(0) }
    }

    fn begin(&self) -> u64 {
        self.latest.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn is_current(&self, request_id: u64) -> bool {
        self.latest.load(Ordering::SeqCst) == request_id
    }
}

/// Fire-and-forget: queries every inline-capable `root-provider` command
/// concurrently (`extension.onQuery`, a real request/response round trip —
/// see `runner.ts::runOnQuery`), off `search()`'s own synchronous return
/// path, and — only if no *newer* query has been dispatched in the
/// meantime — emits the merged row set as one `INLINE_ROWS_EVENT`. A
/// no-op (zero extra cost beyond one `Vec` length check) when no installed
/// extension supports it, which is the common case today.
pub fn dispatch(app: &AppHandle, query: String) {
    let Some(state) = app.try_state::<AppState>() else { return };
    // A disabled extension's rows are already filtered out of ordinary
    // search results (`search_use_case::filter_by_enabled_features`) —
    // inline rows need the identical check here, since
    // `inline_capable_commands` only reflects what a listing *pushed*,
    // not whether the user has since turned it off. Found live while
    // verifying T23's calculator toggle: disabling it in Settings had no
    // effect on its inline row at all until this check was added.
    let targets: Vec<(String, String)> =
        state.root_commands.inline_capable_commands().into_iter().filter(|(extension_id, _)| state.extensions.is_enabled(extension_id)).collect();
    if targets.is_empty() {
        return;
    }

    let request_id = state.inline_queries.begin();
    let app = app.clone();

    tauri::async_runtime::spawn(async move {
        // T23 latency-budget instrumentation (plans/refactor-extension-platform.md's
        // T23 done-condition: "p95 <= 50ms query->row on the warm sidecar,
        // measured before deleting native code") — kept permanently as an
        // ongoing signal, same convention as T33/T34's `search:`/
        // `show_palette:` lines (`info`, not `debug`: tauri_plugin_log's
        // level filter is hardcoded to `LevelFilter::Info`). Brackets the
        // full round trip this budget actually means: every dispatched
        // `extension.onQuery` call plus the staleness check, ending right
        // before the emit that makes a row visible.
        let started_at = std::time::Instant::now();
        let Some(state) = app.try_state::<AppState>() else { return };

        let command_settings = state.command_settings.all();
        let aliases: HashMap<String, String> = command_settings
            .iter()
            .filter_map(|(id, entry)| entry.alias.clone().map(|alias| (id.clone(), alias)))
            .collect();

        let calls = targets.into_iter().filter_map(|(extension_id, host_command_name)| {
            let path = state.extensions.list().into_iter().find(|e| e.id == extension_id)?.path?;
            let command_path = format!("{path}/.openray/build/{host_command_name}.js");
            let (environment, platform) = crate::application::extension_commands::environment_and_platform_json(&state, &path);

            let query = query.clone();
            // "the user's alias mapping for the extension's commands"
            // (plan text) — every alias assigned to one of *this*
            // extension's own ids, keyed by the suffix after
            // `ext:{extensionId}:` rather than the full id, since that's
            // the same opaque-id shape the extension's own rows use.
            let prefix = format!("ext:{extension_id}:");
            let context_aliases: HashMap<String, String> = aliases
                .iter()
                .filter_map(|(id, alias)| id.strip_prefix(prefix.as_str()).map(|suffix| (suffix.to_string(), alias.clone())))
                .collect();
            let extension_host = &state.extension_host;
            Some(async move {
                let params = json!({
                    "extensionId": extension_id,
                    "commandName": host_command_name,
                    "commandPath": command_path,
                    "query": query,
                    "context": { "aliases": context_aliases },
                    "environment": environment,
                    "platform": platform,
                });
                (extension_id, extension_host.call("extension.onQuery", Some(params)).await)
            })
        });

        let replies = join_all(calls).await;
        if !state.inline_queries.is_current(request_id) {
            // A newer query was dispatched while these were in flight —
            // drop this batch entirely rather than racing it against
            // (and possibly clobbering) whatever the newer one emits.
            return;
        }

        let rows: Vec<InlineRow> = replies
            .into_iter()
            .filter_map(|(extension_id, reply)| match reply {
                Ok(value) if value.is_null() => None,
                Ok(value) => match serde_json::from_value::<InlineRow>(value) {
                    Ok(mut row) => {
                        // A row without its own icon falls back to its
                        // extension's manifest icon — same convention as
                        // static/root-provider rows (`extension_commands`/
                        // `root_commands`).
                        if row.icon.is_none() {
                            row.icon = state.extensions.list().into_iter().find(|e| e.id == extension_id).and_then(|e| e.icon);
                        }
                        // Never trust an extension's own reply for this —
                        // Rust already knows authoritatively which
                        // extension produced this row (`extension_id` is
                        // this closure's own loop variable, not anything
                        // parsed from the reply).
                        if row.command_name.is_some() {
                            row.extension_id = Some(extension_id);
                        }
                        Some(row)
                    }
                    Err(e) => {
                        log::warn!("extension.onQuery reply didn't parse as an InlineRow: {e}");
                        None
                    }
                },
                Err(e) => {
                    log::warn!("extension.onQuery failed: {e}");
                    None
                }
            })
            .collect();

        log::info!("inline_query: {}us", started_at.elapsed().as_micros());
        let _ = app.emit(INLINE_ROWS_EVENT, InlineRowsPayload { rows });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_freshly_begun_request_is_current() {
        let dispatcher = InlineQueryDispatcher::new();
        let id = dispatcher.begin();
        assert!(dispatcher.is_current(id));
    }

    #[test]
    fn an_older_request_is_stale_once_a_newer_one_begins() {
        let dispatcher = InlineQueryDispatcher::new();
        let first = dispatcher.begin();
        let second = dispatcher.begin();
        assert_ne!(first, second);
        assert!(!dispatcher.is_current(first));
        assert!(dispatcher.is_current(second));
    }

    #[test]
    fn successive_requests_get_distinct_increasing_ids() {
        let dispatcher = InlineQueryDispatcher::new();
        let ids: Vec<u64> = (0..5).map(|_| dispatcher.begin()).collect();
        let mut sorted = ids.clone();
        sorted.sort_unstable();
        assert_eq!(ids, sorted, "ids should already arrive in increasing order");
        assert_eq!(ids.iter().collect::<std::collections::HashSet<_>>().len(), 5, "ids must be distinct");
    }

    #[test]
    fn card_fields_round_trip_through_camel_case_json() {
        let row = InlineRow {
            id: "calc".to_string(),
            title: "42".to_string(),
            subtitle: None,
            icon: None,
            value: Some("42".to_string()),
            value_raw: None,
            command_name: None,
            extension_id: None,
            argument: None,
            display: Some("card".to_string()),
            section_label: Some("Calculator".to_string()),
            card_left: Some("6 * 7".to_string()),
            card_right: None,
        };

        let json = serde_json::to_value(&row).expect("InlineRow should serialize");
        assert_eq!(json["display"], "card");
        assert_eq!(json["sectionLabel"], "Calculator");
        assert_eq!(json["cardLeft"], "6 * 7");
        assert!(json.get("cardRight").is_none(), "absent card_right must be omitted, not null");

        let round_tripped: InlineRow = serde_json::from_value(json).expect("InlineRow should deserialize");
        assert_eq!(round_tripped, row);
    }

    #[test]
    fn extension_reply_missing_card_fields_deserializes_with_none() {
        let reply = json!({ "id": "row", "title": "Result" });
        let row: InlineRow = serde_json::from_value(reply).expect("a reply with only required fields should still parse");
        assert_eq!(row.display, None);
        assert_eq!(row.section_label, None);
        assert_eq!(row.card_left, None);
        assert_eq!(row.card_right, None);
    }
}
