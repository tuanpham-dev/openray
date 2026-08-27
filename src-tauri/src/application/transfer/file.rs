//! The on-disk export file: a plaintext header wrapping an opaque
//! payload. The header stays readable without a passphrase on purpose —
//! [`inspect`] is what lets the Import flow decide whether to prompt for
//! one *before* asking the user for anything, which is the whole point of
//! the `encrypted` flag living outside the sealed bytes.
//!
//! ```json
//! {
//!   "format": "openray-export",
//!   "version": 2,
//!   "encrypted": true,
//!   "kdfSalt": "<hex>",
//!   "payload": "<base64 of crypto::seal(key, payload JSON)>"
//! }
//! ```
//!
//! When unencrypted, `payload` is the payload object inline rather than a
//! base64 string, so an unencrypted export is a plain readable JSON file
//! the user can inspect (or hand-edit) with no tooling.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::Path;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::crypto::{self, Key32};
use super::snapshot::{Snapshot, SNAPSHOT_VERSION};
use crate::error::Error;

const FORMAT_TAG: &str = "openray-export";

/// What an export file carries: the host's own snapshot, plus one opaque
/// payload per extension that produced its own via its `exportData` hook.
///
/// Blobs are deliberately absent — clipboard export is text-only, see
/// [`super::export_to_file`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Payload {
    pub snapshot: Snapshot,
    /// Keyed by extension id. `#[serde(default)]` so a file written before
    /// extensions could contribute payloads still reads.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub extensions: BTreeMap<String, ExtensionPayload>,
}

/// One extension's self-described data. Both fields are opaque to the
/// host: it stores what `exportData` returned and hands it back to
/// `importData` unchanged, so the extension alone decides what its data
/// means and how to migrate it across its own versions.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtensionPayload {
    #[serde(default)]
    pub version: Value,
    #[serde(default)]
    pub data: Value,
}

/// The file's plaintext header, deserialized without touching `payload`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportFile {
    format: String,
    /// The writing app's [`SNAPSHOT_VERSION`]. Informational only —
    /// import is deliberately best-effort across versions (see
    /// [`read_export`]).
    version: u32,
    encrypted: bool,
    /// Hex, present only when `encrypted`. A fresh salt per export.
    #[serde(skip_serializing_if = "Option::is_none")]
    kdf_salt: Option<String>,
    payload: Value,
}

/// What [`inspect`] can tell the frontend about a file without a
/// passphrase: whether one is needed at all, and which app version wrote
/// it (surfaced for diagnostics, never used to reject the file).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub encrypted: bool,
    pub version: u32,
}

/// Serializes `payload`, seals it under a key derived from `passphrase`
/// when one is given, and writes the whole file atomically (temp +
/// rename), so a crash or a half-finished write never leaves a truncated
/// file where a valid export used to be.
pub fn write_export(path: &Path, payload: &Payload, passphrase: Option<&str>) -> Result<(), Error> {
    let payload_json = serde_json::to_value(payload)?;

    let file = match passphrase {
        Some(passphrase) => {
            let salt = crypto::generate_salt()?;
            let key = crypto::derive_key(passphrase, &salt)?;
            let sealed = crypto::seal(&key, payload_json.to_string().as_bytes())?;
            ExportFile {
                format: FORMAT_TAG.to_string(),
                version: SNAPSHOT_VERSION,
                encrypted: true,
                kdf_salt: Some(crypto::to_hex(&salt)),
                payload: Value::String(BASE64.encode(sealed)),
            }
        }
        None => ExportFile { format: FORMAT_TAG.to_string(), version: SNAPSHOT_VERSION, encrypted: false, kdf_salt: None, payload: payload_json },
    };

    let bytes = serde_json::to_vec_pretty(&file)?;
    atomic_write(path, &bytes)?;
    Ok(())
}

/// Reads only the header, so the Import flow can decide whether to prompt
/// for a passphrase before asking the user for anything.
pub fn inspect(path: &Path) -> Result<FileInfo, Error> {
    let file = read_header(path)?;
    Ok(FileInfo { encrypted: file.encrypted, version: file.version })
}

/// Reads and (when sealed) decrypts a file written by [`write_export`].
///
/// Deliberately does *not* gate on `version`: import is best-effort
/// across app versions, and `snapshot::apply`'s own unknown-kind fallback
/// already skips a record kind this build doesn't recognize. A file from
/// a newer app therefore imports what it can rather than being refused
/// wholesale.
pub fn read_export(path: &Path, passphrase: Option<&str>) -> Result<Payload, Error> {
    let file = read_header(path)?;

    let payload_json = if file.encrypted {
        let Some(passphrase) = passphrase else {
            return Err(Error::msg("this file is encrypted — a passphrase is required"));
        };
        let salt_hex = file.kdf_salt.as_deref().ok_or_else(|| Error::msg("this export file is encrypted but has no kdfSalt"))?;
        let salt = crypto::from_hex(salt_hex).ok_or_else(|| Error::msg("this export file has a corrupted kdfSalt"))?;
        let sealed_b64 = file.payload.as_str().ok_or_else(|| Error::msg("this export file's encrypted payload is not a string"))?;
        let sealed = BASE64.decode(sealed_b64).map_err(|_| Error::msg("this export file's payload is not valid base64"))?;

        let key: Key32 = crypto::derive_key(passphrase, &salt)?;
        // AEAD can't distinguish a wrong key from tampered bytes, so this
        // one message has to cover both — the passphrase is far and away
        // the likelier of the two from the user's side.
        let plaintext = crypto::open(&key, &sealed).map_err(|_| Error::msg("wrong passphrase, or this file is corrupted"))?;
        serde_json::from_slice(&plaintext)?
    } else {
        file.payload
    };

    Ok(serde_json::from_value(payload_json)?)
}

fn read_header(path: &Path) -> Result<ExportFile, Error> {
    let contents = fs::read_to_string(path)?;
    let file: ExportFile = serde_json::from_str(&contents).map_err(|_| Error::msg("this is not an OpenRay export file"))?;
    if file.format != FORMAT_TAG {
        return Err(Error::msg("this is not an OpenRay export file"));
    }
    Ok(file)
}

/// Temp + rename, with a random temp suffix so two concurrent exports to
/// the same path can't consume each other's in-progress write. Mirrors
/// the convention the (now-removed) sync folder layer used.
fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let tmp = path.with_extension(format!("tmp.{}", crate::infrastructure::time::pseudo_uuid()));
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::application::transfer::snapshot::Record;
    use serde_json::json;

    fn test_path(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("openray-export-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir.join(format!("{name}.json"))
    }

    fn sample_payload() -> Payload {
        Payload {
            extensions: BTreeMap::new(),
            snapshot: Snapshot {
                version: SNAPSHOT_VERSION,
                device_id: "export".into(),
                records: vec![Record { kind: "extension_storage".into(), id: "snippets:s1".into(), updated_at: 1000, deleted: false, fields: json!({"value": "hello"}) }],
                portable_settings: None,
            },
        }
    }

    #[test]
    fn an_encrypted_file_round_trips_and_hides_its_contents() {
        let path = test_path("encrypted-roundtrip");
        write_export(&path, &sample_payload(), Some("correct horse")).unwrap();

        let raw = fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("hello"), "the payload must not be readable in the file");

        let read = read_export(&path, Some("correct horse")).unwrap();
        assert_eq!(read.snapshot.records[0].fields["value"], "hello");
    }

    #[test]
    fn an_unencrypted_file_round_trips_as_plain_readable_json() {
        let path = test_path("plain-roundtrip");
        write_export(&path, &sample_payload(), None).unwrap();

        let raw = fs::read_to_string(&path).unwrap();
        assert!(raw.contains("hello"), "an unencrypted export should be readable as-is");

        let read = read_export(&path, None).unwrap();
        assert_eq!(read.snapshot.records[0].fields["value"], "hello");
    }

    #[test]
    fn inspect_reports_encryption_without_a_passphrase() {
        let encrypted = test_path("inspect-encrypted");
        write_export(&encrypted, &sample_payload(), Some("pw")).unwrap();
        assert!(inspect(&encrypted).unwrap().encrypted);

        let plain = test_path("inspect-plain");
        write_export(&plain, &sample_payload(), None).unwrap();
        assert!(!inspect(&plain).unwrap().encrypted);
    }

    #[test]
    fn a_wrong_passphrase_is_rejected_with_a_passphrase_specific_message() {
        let path = test_path("wrong-passphrase");
        write_export(&path, &sample_payload(), Some("the right one")).unwrap();

        let err = read_export(&path, Some("the wrong one")).unwrap_err().to_string();
        assert!(err.contains("wrong passphrase"), "got: {err}");
    }

    #[test]
    fn reading_an_encrypted_file_without_a_passphrase_says_one_is_required() {
        let path = test_path("passphrase-required");
        write_export(&path, &sample_payload(), Some("pw")).unwrap();

        let err = read_export(&path, None).unwrap_err().to_string();
        assert!(err.contains("passphrase is required"), "got: {err}");
    }

    #[test]
    fn a_file_that_is_not_an_export_is_rejected_before_any_passphrase_prompt() {
        let path = test_path("not-an-export");
        fs::write(&path, br#"{"some": "other json"}"#).unwrap();
        assert!(inspect(&path).unwrap_err().to_string().contains("not an OpenRay export file"));

        let garbage = test_path("garbage");
        fs::write(&garbage, b"not json at all").unwrap();
        assert!(inspect(&garbage).unwrap_err().to_string().contains("not an OpenRay export file"));
    }

    #[test]
    fn a_file_from_an_unfamiliar_version_still_imports() {
        // Best-effort import: the version is recorded for diagnostics,
        // never used to refuse a file. `snapshot::apply` skips record
        // kinds it doesn't know, which is where cross-version tolerance
        // actually lives.
        let path = test_path("future-version");
        write_export(&path, &sample_payload(), None).unwrap();
        let mut file: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        file["version"] = json!(SNAPSHOT_VERSION + 99);
        fs::write(&path, serde_json::to_vec(&file).unwrap()).unwrap();

        let read = read_export(&path, None).unwrap();
        assert_eq!(read.snapshot.records[0].fields["value"], "hello");
    }

    #[test]
    fn an_extension_payload_round_trips_verbatim() {
        let path = test_path("extension-payload");
        let mut payload = sample_payload();
        payload.extensions.insert(
            "quicklinks".into(),
            ExtensionPayload { version: json!(3), data: json!({"links": [{"name": "docs", "url": "https://example.com"}]}) },
        );

        write_export(&path, &payload, None).unwrap();
        let read = read_export(&path, None).unwrap();

        let quicklinks = read.extensions.get("quicklinks").expect("the extension's payload must survive");
        assert_eq!(quicklinks.version, json!(3), "the extension's own version is stored verbatim");
        assert_eq!(quicklinks.data["links"][0]["url"], "https://example.com");
    }

    #[test]
    fn a_file_written_before_extension_payloads_existed_still_reads() {
        // The `extensions` key is `#[serde(default)]` precisely so an
        // export taken by an earlier build stays importable.
        let path = test_path("no-extensions-key");
        write_export(&path, &sample_payload(), None).unwrap();
        let raw = fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("\"extensions\""), "an empty map must not be written at all");

        assert!(read_export(&path, None).unwrap().extensions.is_empty());
    }

    #[test]
    fn no_temp_file_survives_a_completed_write() {
        let path = test_path("no-temp-leftovers");
        write_export(&path, &sample_payload(), None).unwrap();

        let dir = path.parent().unwrap();
        let leftover = fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| e.path().extension().and_then(|x| x.to_str()).is_some_and(|x| x.starts_with("tmp")));
        assert!(!leftover, "no temp file should survive a completed write");
    }
}
