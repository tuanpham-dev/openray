//! Keeping registry-installed extensions current, automatically.
//!
//! This is the one part of the extension system that applies remote code
//! without anyone asking for it, so the constraints are deliberate and
//! narrow:
//!
//! - **Same source only.** An update is applied when the newer build comes
//!   from the exact registry the extension was installed from. A different
//!   registry offering the same id is a *replacement*, and those always go
//!   through an explicit confirmation (see `api::registry::classify_install`).
//! - **Per-source consent.** A source with `auto_update` off is checked but
//!   never installed from; its updates surface in the Store instead.
//! - **Everything an interactive install does.** The digest check, the
//!   capability check, and the staged swap-with-rollback all live below the
//!   install call, so an automatic update is not a weaker path than a
//!   manual one — it is the same path with nobody watching.
//! - **Never touches what isn't ours.** Built-ins, dev extensions, and
//!   anything installed from a file or a slug have no `source_url` and are
//!   skipped entirely.
//!
//! It is still unsigned code arriving without user action, which is exactly
//! why archive signing sits at the top of the post-v1 list.

use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::application::state::AppState;

/// How often a running app re-checks. Deliberately unhurried: registries
/// are static files behind a CDN, the check is conditional on an ETag, and
/// nothing here is urgent enough to justify waking up more often.
const CHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);

/// Grace period after launch. Startup is already contended (window,
/// hotkeys, root providers, the sidecar itself), and an update check is the
/// least urgent thing happening.
const STARTUP_DELAY: Duration = Duration::from_secs(90);

/// Emitted after each pass so the Store can show what happened without
/// polling for it.
pub const EXTENSION_UPDATES_EVENT: &str = "extension-updates";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateOutcome {
    pub id: String,
    pub from: Option<String>,
    pub to: String,
    pub source_url: String,
    /// `None` when it worked; the failure otherwise. A failed update leaves
    /// the previous version in place (`installArchive` restores it), so this
    /// is a report, not a broken extension.
    pub error: Option<String>,
}

/// An update that exists but wasn't applied, because its source has
/// auto-update switched off. The Store lists these as pending.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PendingUpdate {
    pub id: String,
    pub from: Option<String>,
    pub to: String,
    pub source_url: String,
    pub file_url: String,
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateReport {
    pub applied: Vec<UpdateOutcome>,
    pub pending: Vec<PendingUpdate>,
    /// Registries that couldn't be read this pass (offline, moved, broken).
    pub unreachable: Vec<String>,
}

/// One catalog entry, reduced to what an update decision needs.
#[derive(Debug, Clone, PartialEq)]
pub struct CatalogVersion {
    pub id: String,
    pub version: String,
    pub file_url: String,
    pub sha256: Option<String>,
}

/// Whether `candidate` should replace `installed`.
///
/// Versions are compared as dotted numeric sequences when both sides look
/// numeric, and by plain inequality otherwise. The looser fallback is
/// deliberate: registry CI stamps synthesized `0.<yyyymmdd>.<n>` versions
/// for extensions whose manifests declare none, but a hand-published
/// registry may use anything at all, and refusing to update those would
/// silently strand them. An installed extension with *no* recorded version
/// is treated as older than any catalog version — it predates version
/// tracking, so a catalog that names a version is better information.
pub fn is_newer(installed: Option<&str>, candidate: &str) -> bool {
    let Some(installed) = installed else { return true };
    if installed == candidate {
        return false;
    }
    match (parse_version(installed), parse_version(candidate)) {
        (Some(current), Some(next)) => next > current,
        // Not comparable as numbers: "different" is the only signal
        // available, and the catalog is the more authoritative side.
        _ => true,
    }
}

/// Parses a version as a dotted numeric sequence, or `None` for anything
/// else.
///
/// Only a `+build` suffix is stripped (semver says it carries no ordering
/// anyway, and `0.0.0+<sha>` is a plausible registry scheme). A `-` suffix
/// is deliberately *not* stripped: doing so turns the date-style
/// `2026-01-01` into `2026`, which then compares equal to every other date
/// in that year — an extension that silently stops updating. Versions
/// carrying a semver prerelease (`1.0.0-beta`) therefore fall to the
/// difference-based fallback in `is_newer`, which is the honest answer
/// given this can't order prereleases correctly anyway.
fn parse_version(version: &str) -> Option<Vec<u64>> {
    let core = version.split('+').next()?;
    let parts: Vec<u64> = core.split('.').map(|part| part.parse::<u64>().ok()).collect::<Option<_>>()?;
    if parts.is_empty() {
        return None;
    }
    // Pad so 1.2 and 1.2.0 compare equal rather than by length.
    let mut padded = parts;
    while padded.len() < 3 {
        padded.push(0);
    }
    Some(padded)
}

/// Starts the background checker. Idempotent per app instance — called once
/// from `lib.rs`'s setup.
pub fn spawn(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(STARTUP_DELAY).await;
        loop {
            match run_once(&app).await {
                Ok(report) => {
                    if !report.applied.is_empty() || !report.pending.is_empty() {
                        if let Err(e) = app.emit(EXTENSION_UPDATES_EVENT, &report) {
                            log::warn!("failed to emit an extension update report: {e}");
                        }
                    }
                }
                Err(e) => log::warn!("extension update check failed: {e}"),
            }
            tokio::time::sleep(CHECK_INTERVAL).await;
        }
    });
}

/// One full pass: read every enabled registry, compare against what's
/// installed, apply what may be applied.
pub async fn run_once(app: &AppHandle) -> Result<UpdateReport, String> {
    let mut report = UpdateReport::default();

    let (sources, installed) = {
        let Some(state) = app.try_state::<AppState>() else { return Ok(report) };
        (state.registry_sources.enabled(), state.extensions.list())
    };
    if sources.is_empty() {
        return Ok(report);
    }

    for source in sources {
        let catalog = {
            let Some(state) = app.try_state::<AppState>() else { return Ok(report) };
            crate::api::registry::fetch_registry_catalog(app.clone(), state, source.url.clone()).await
        };
        let versions = match catalog {
            Ok(value) => catalog_versions(&value),
            Err(e) => {
                log::warn!("update check: could not read {}: {e}", source.url);
                report.unreachable.push(source.url.clone());
                continue;
            }
        };

        for extension in &installed {
            // Only extensions this very registry installed. Anything else —
            // a built-in, a dev folder, a hand-picked file, or the same id
            // from a different registry — is not ours to update silently.
            if extension.source_url.as_deref() != Some(source.url.as_str()) {
                continue;
            }
            let Some(candidate) = versions.iter().find(|entry| entry.id == extension.id) else { continue };
            if !is_newer(extension.version.as_deref(), &candidate.version) {
                continue;
            }

            if !source.auto_update {
                report.pending.push(PendingUpdate {
                    id: extension.id.clone(),
                    from: extension.version.clone(),
                    to: candidate.version.clone(),
                    source_url: source.url.clone(),
                    file_url: candidate.file_url.clone(),
                    sha256: candidate.sha256.clone(),
                });
                continue;
            }

            let Some(state) = app.try_state::<AppState>() else { return Ok(report) };
            let outcome = crate::api::registry::install_from_registry_inner(
                app,
                &state,
                &source.url,
                &candidate.file_url,
                candidate.sha256.as_deref(),
            )
            .await;
            match outcome {
                Ok(_) => {
                    log::info!("auto-updated '{}' to {}", extension.id, candidate.version);
                    report.applied.push(UpdateOutcome {
                        id: extension.id.clone(),
                        from: extension.version.clone(),
                        to: candidate.version.clone(),
                        source_url: source.url.clone(),
                        error: None,
                    });
                }
                Err(e) => {
                    // The previous version is still installed — the staged
                    // swap restores it — so this is reportable, not fatal.
                    log::warn!("auto-update of '{}' failed: {e}", extension.id);
                    report.applied.push(UpdateOutcome {
                        id: extension.id.clone(),
                        from: extension.version.clone(),
                        to: candidate.version.clone(),
                        source_url: source.url.clone(),
                        error: Some(e),
                    });
                }
            }
        }
    }

    Ok(report)
}

/// Pulls the update-relevant fields out of a catalog payload. Entries
/// without a version can't be compared, so they're skipped rather than
/// guessed at.
pub fn catalog_versions(catalog: &Value) -> Vec<CatalogVersion> {
    let Some(entries) = catalog.get("extensions").and_then(Value::as_array) else { return Vec::new() };
    entries
        .iter()
        .filter_map(|entry| {
            Some(CatalogVersion {
                id: entry.get("name")?.as_str()?.to_string(),
                version: entry.get("version")?.as_str()?.to_string(),
                file_url: entry.get("file")?.as_str()?.to_string(),
                sha256: entry.get("sha256").and_then(Value::as_str).map(str::to_string),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn compares_dotted_numeric_versions() {
        assert!(is_newer(Some("1.0.0"), "1.0.1"));
        assert!(is_newer(Some("1.9.0"), "1.10.0"), "10 is newer than 9, not older");
        assert!(!is_newer(Some("2.0.0"), "1.9.9"));
        assert!(!is_newer(Some("1.2.0"), "1.2.0"));
        assert!(!is_newer(Some("1.2"), "1.2.0"), "1.2 and 1.2.0 are the same version");
    }

    #[test]
    fn compares_the_synthesized_date_versions_registry_ci_stamps() {
        assert!(is_newer(Some("0.20260101.0"), "0.20260827.0"));
        assert!(!is_newer(Some("0.20260827.1"), "0.20260827.0"));
    }

    #[test]
    fn treats_an_unversioned_install_as_updatable() {
        // Installed before version tracking existed: the catalog naming a
        // version is strictly better information than none.
        assert!(is_newer(None, "1.0.0"));
    }

    #[test]
    fn falls_back_to_difference_for_non_numeric_versions() {
        // A hand-published registry may version however it likes; refusing
        // to update those would strand them silently.
        assert!(is_newer(Some("2026-01-01"), "2026-08-27"));
        assert!(!is_newer(Some("stable"), "stable"));
    }

    #[test]
    fn reads_update_relevant_fields_and_skips_unversioned_entries() {
        let catalog = json!({
            "extensions": [
                { "name": "alpha", "version": "1.2.0", "file": "https://x.test/r/alpha.orx", "sha256": "abc" },
                { "name": "beta", "file": "https://x.test/r/beta.orx" },
                { "name": "gamma", "version": "0.1.0", "file": "https://x.test/r/gamma.orx" },
            ]
        });
        let versions = catalog_versions(&catalog);
        assert_eq!(versions.len(), 2, "an entry with no version can't be compared");
        assert_eq!(versions[0].id, "alpha");
        assert_eq!(versions[0].sha256.as_deref(), Some("abc"));
        assert_eq!(versions[1].id, "gamma");
        assert_eq!(versions[1].sha256, None);
    }

    #[test]
    fn a_catalog_without_extensions_yields_nothing() {
        assert!(catalog_versions(&json!({})).is_empty());
        assert!(catalog_versions(&json!({ "extensions": "nope" })).is_empty());
    }
}
