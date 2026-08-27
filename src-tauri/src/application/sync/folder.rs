//! On-disk layout of the sync folder: `<folder>/openray-sync/{meta.json,
//! devices/, blobs/}`. Every write here is atomic (temp file + rename) so a
//! file-sync tool never delivers a half-written file to another device.
//! Every read tolerates a corrupted or partially-synced file by skipping it
//! with a warning rather than failing the whole read — see [`read_snapshots`].

use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::crypto::{self, Key32};
use super::snapshot::{BlobRef, Snapshot};

const SYNC_DIR: &str = "openray-sync";
const META_FILE: &str = "meta.json";
const DEVICES_DIR: &str = "devices";
const BLOBS_DIR: &str = "blobs";

/// Written once, by whichever device sets the sync passphrase first;
/// every later device verifies its own derived key against `keycheck`
/// before trusting it. `kdf_salt` and `keycheck` are hex-encoded — see
/// `crypto::generate_salt`/`crypto::seal_keycheck`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Meta {
    pub version: u32,
    pub kdf_salt: String,
    pub keycheck: String,
}

pub fn sync_dir(folder: &Path) -> PathBuf {
    folder.join(SYNC_DIR)
}

pub fn ensure_layout(folder: &Path) -> io::Result<()> {
    let root = sync_dir(folder);
    fs::create_dir_all(root.join(DEVICES_DIR))?;
    fs::create_dir_all(root.join(BLOBS_DIR))?;
    Ok(())
}

pub fn read_meta(folder: &Path) -> io::Result<Option<Meta>> {
    let path = sync_dir(folder).join(META_FILE);
    match fs::read_to_string(&path) {
        Ok(contents) => Ok(serde_json::from_str(&contents).ok()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

pub fn write_meta(folder: &Path, meta: &Meta) -> io::Result<()> {
    ensure_layout(folder)?;
    let json = serde_json::to_string_pretty(meta).map_err(io::Error::other)?;
    atomic_write(&sync_dir(folder).join(META_FILE), json.as_bytes())
}

/// The temp filename includes a per-call random suffix (not a fixed
/// `.tmp`) so two overlapping writers — the worker loop and a
/// user-triggered "Sync Now" that raced past the cycle lock in
/// [`SyncProvider::sync_now`] — never share one temp path and clobber
/// each other's write before either rename lands.
fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let tmp = path.with_extension(format!("tmp.{}", crate::infrastructure::time::pseudo_uuid()));
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path)
}

/// Seals `snapshot` under `key` and writes it to this device's own file —
/// `devices/<device_id>.snap`. A device only ever writes its own file, so
/// two devices never race on the same path.
pub fn write_snapshot(folder: &Path, device_id: &str, key: &Key32, snapshot: &Snapshot) -> io::Result<()> {
    ensure_layout(folder)?;
    let json = serde_json::to_vec(snapshot).map_err(io::Error::other)?;
    let sealed = crypto::seal(key, &json).map_err(io::Error::other)?;
    let path = sync_dir(folder).join(DEVICES_DIR).join(format!("{device_id}.snap"));
    atomic_write(&path, &sealed)
}

/// Reads every other device's snapshot file (never `own_device_id`'s own).
/// A file that fails to decrypt (wrong key, or a file-sync tool delivered
/// only part of it) or fails to parse is logged and skipped, not treated
/// as fatal — the device it belongs to will simply be missing from this
/// round, and its content arrives on the next successful read.
pub fn read_snapshots(folder: &Path, own_device_id: &str, key: &Key32) -> io::Result<Vec<Snapshot>> {
    let devices_dir = sync_dir(folder).join(DEVICES_DIR);
    let mut snapshots = Vec::new();

    let entries = match fs::read_dir(&devices_dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(snapshots),
        Err(e) => return Err(e),
    };

    for entry in entries {
        let path = entry?.path();
        if path.extension().and_then(|e| e.to_str()) != Some("snap") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else { continue };
        if stem == own_device_id {
            continue;
        }

        let sealed = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(e) => {
                log::warn!("sync: failed to read {path:?}: {e}");
                continue;
            }
        };
        let plaintext = match crypto::open(key, &sealed) {
            Ok(bytes) => bytes,
            Err(e) => {
                log::warn!("sync: skipping {path:?} — failed to decrypt (wrong key or a partially-synced file): {e}");
                continue;
            }
        };
        match serde_json::from_slice::<Snapshot>(&plaintext) {
            Ok(snapshot) => snapshots.push(snapshot),
            Err(e) => log::warn!("sync: skipping {path:?} — decrypted but failed to parse: {e}"),
        }
    }

    Ok(snapshots)
}

/// Seals `blob.path`'s bytes into `blobs/<hash>.bin` if not already
/// present — content-addressed, so re-pushing the same image is a no-op.
pub fn push_blob(folder: &Path, key: &Key32, blob: &BlobRef) -> io::Result<()> {
    ensure_layout(folder)?;
    let dest = sync_dir(folder).join(BLOBS_DIR).join(format!("{}.bin", blob.hash));
    if dest.exists() {
        return Ok(());
    }
    let bytes = fs::read(&blob.path)?;
    let sealed = crypto::seal(key, &bytes).map_err(io::Error::other)?;
    atomic_write(&dest, &sealed)
}

/// Decrypts `blobs/<hash>.bin` into a new file under `dest_dir`, returning
/// its path so the caller can point a `clipboard_history.image_path` at it.
pub fn pull_blob(folder: &Path, key: &Key32, hash: &str, dest_dir: &Path) -> io::Result<PathBuf> {
    fs::create_dir_all(dest_dir)?;
    let sealed = fs::read(sync_dir(folder).join(BLOBS_DIR).join(format!("{hash}.bin")))?;
    let plaintext = crypto::open(key, &sealed).map_err(io::Error::other)?;
    let dest = dest_dir.join(format!("{hash}.png"));
    fs::write(&dest, &plaintext)?;
    Ok(dest)
}

/// Deletes blob files referenced by none of `live_snapshots` (this
/// device's own export plus every other device's most recently read
/// snapshot) — a blob only disappears once no readable snapshot points to
/// it any more, matching the plan's "delete blob files whose hash appears
/// in no readable snapshot".
pub fn gc_blobs(folder: &Path, live_snapshots: &[Snapshot]) -> io::Result<()> {
    let referenced: HashSet<&str> = live_snapshots
        .iter()
        .flat_map(|s| s.records.iter())
        .filter(|r| r.kind == "clipboard_history" && !r.deleted)
        .filter_map(|r| r.fields.get("imageContentHash").and_then(|v| v.as_str()))
        .collect();

    let blobs_dir = sync_dir(folder).join(BLOBS_DIR);
    let entries = match fs::read_dir(&blobs_dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };

    for entry in entries {
        let path = entry?.path();
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else { continue };
        if !referenced.contains(stem) {
            let _ = fs::remove_file(&path);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::application::sync::snapshot::{Record, SNAPSHOT_VERSION};
    use serde_json::json;

    fn test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("openray-sync-folder-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn test_key() -> Key32 {
        let salt = crypto::generate_salt().unwrap();
        crypto::derive_key("test passphrase", &salt).unwrap()
    }

    fn empty_snapshot(device_id: &str) -> Snapshot {
        Snapshot { version: SNAPSHOT_VERSION, device_id: device_id.to_string(), records: vec![], portable_settings: None }
    }

    #[test]
    fn write_then_read_round_trips_a_snapshot_from_another_device() {
        let dir = test_dir("roundtrip");
        let key = test_key();
        let mut snapshot = empty_snapshot("device-b");
        snapshot.records.push(Record { kind: "snippets".into(), id: "s1".into(), updated_at: 1000, deleted: false, fields: json!({"body": "hello"}) });

        write_snapshot(&dir, "device-b", &key, &snapshot).unwrap();
        let read = read_snapshots(&dir, "device-a", &key).unwrap();

        assert_eq!(read.len(), 1);
        assert_eq!(read[0].device_id, "device-b");
        assert_eq!(read[0].records[0].fields["body"], "hello");
    }

    #[test]
    fn read_snapshots_never_returns_the_readers_own_file() {
        let dir = test_dir("own-file-excluded");
        let key = test_key();
        write_snapshot(&dir, "device-a", &key, &empty_snapshot("device-a")).unwrap();
        write_snapshot(&dir, "device-b", &key, &empty_snapshot("device-b")).unwrap();

        let read = read_snapshots(&dir, "device-a", &key).unwrap();

        assert_eq!(read.len(), 1);
        assert_eq!(read[0].device_id, "device-b");
    }

    #[test]
    fn a_snapshot_sealed_with_the_wrong_key_is_skipped_not_fatal() {
        let dir = test_dir("wrong-key");
        let right_key = test_key();
        let wrong_salt = crypto::generate_salt().unwrap();
        let wrong_key = crypto::derive_key("a different passphrase", &wrong_salt).unwrap();
        write_snapshot(&dir, "device-b", &wrong_key, &empty_snapshot("device-b")).unwrap();

        let read = read_snapshots(&dir, "device-a", &right_key).unwrap();

        assert!(read.is_empty(), "an unreadable snapshot must be skipped, not error the whole read");
    }

    #[test]
    fn a_truncated_snapshot_file_is_skipped_not_fatal() {
        let dir = test_dir("truncated");
        let key = test_key();
        ensure_layout(&dir).unwrap();
        fs::write(sync_dir(&dir).join(DEVICES_DIR).join("device-b.snap"), b"not even close to valid").unwrap();

        let read = read_snapshots(&dir, "device-a", &key).unwrap();

        assert!(read.is_empty());
    }

    #[test]
    fn meta_round_trips() {
        let dir = test_dir("meta");
        let meta = Meta { version: 1, kdf_salt: "abcd".into(), keycheck: "ef01".into() };

        write_meta(&dir, &meta).unwrap();
        let read = read_meta(&dir).unwrap().unwrap();

        assert_eq!(read.kdf_salt, "abcd");
        assert_eq!(read.keycheck, "ef01");
    }

    #[test]
    fn read_meta_returns_none_when_never_written() {
        let dir = test_dir("meta-missing");
        assert!(read_meta(&dir).unwrap().is_none());
    }

    #[test]
    fn push_then_pull_round_trips_a_blob() {
        let dir = test_dir("blob-roundtrip");
        let key = test_key();
        let source_dir = test_dir("blob-source");
        fs::create_dir_all(&source_dir).unwrap();
        let source_path = source_dir.join("clip.png");
        fs::write(&source_path, b"fake png bytes").unwrap();

        push_blob(&dir, &key, &BlobRef { hash: "abc123".into(), path: source_path }).unwrap();
        let dest_dir = test_dir("blob-dest");
        let pulled_path = pull_blob(&dir, &key, "abc123", &dest_dir).unwrap();

        assert_eq!(fs::read(&pulled_path).unwrap(), b"fake png bytes");
    }

    #[test]
    fn pushing_the_same_blob_twice_is_a_no_op() {
        let dir = test_dir("blob-idempotent");
        let key = test_key();
        let source_dir = test_dir("blob-idempotent-source");
        fs::create_dir_all(&source_dir).unwrap();
        let source_path = source_dir.join("clip.png");
        fs::write(&source_path, b"original bytes").unwrap();

        let blob = BlobRef { hash: "same-hash".into(), path: source_path.clone() };
        push_blob(&dir, &key, &blob).unwrap();
        let blob_file = sync_dir(&dir).join(BLOBS_DIR).join("same-hash.bin");
        let first_write_contents = fs::read(&blob_file).unwrap();

        // Even if the source file changed since, a second push with the
        // same hash must not re-seal (content-addressed: same hash means
        // "already have this content").
        fs::write(&source_path, b"different bytes now").unwrap();
        push_blob(&dir, &key, &blob).unwrap();

        assert_eq!(fs::read(&blob_file).unwrap(), first_write_contents);
    }

    #[test]
    fn gc_removes_blobs_no_live_snapshot_references() {
        let dir = test_dir("gc");
        let key = test_key();
        let source_dir = test_dir("gc-source");
        fs::create_dir_all(&source_dir).unwrap();
        let source_path = source_dir.join("clip.png");
        fs::write(&source_path, b"bytes").unwrap();

        push_blob(&dir, &key, &BlobRef { hash: "kept".into(), path: source_path.clone() }).unwrap();
        push_blob(&dir, &key, &BlobRef { hash: "orphaned".into(), path: source_path }).unwrap();

        let mut live = empty_snapshot("device-a");
        live.records.push(Record { kind: "clipboard_history".into(), id: "c1".into(), updated_at: 1, deleted: false, fields: json!({"imageContentHash": "kept"}) });

        gc_blobs(&dir, &[live]).unwrap();

        assert!(sync_dir(&dir).join(BLOBS_DIR).join("kept.bin").exists());
        assert!(!sync_dir(&dir).join(BLOBS_DIR).join("orphaned.bin").exists());
    }

    #[test]
    fn concurrent_writes_to_the_same_snapshot_never_corrupt_or_drop_the_file() {
        // Before the fix, `atomic_write` used a fixed `.tmp` extension, so
        // two overlapping writers (a worker-loop cycle racing a
        // user-triggered "Sync Now") could both write to the *same* temp
        // path and one's `fs::rename` could consume the other's
        // in-progress write — landing a truncated or missing snapshot.
        // Each writer here uses a random per-call temp suffix, so this
        // asserts every concurrent write completes cleanly and the file
        // left behind is always one writer's complete, valid content —
        // never a mix, never absent.
        let dir = test_dir("concurrent-writes");
        let key = test_key();
        let device_id = "device-a";

        let handles: Vec<_> = (0..8)
            .map(|i| {
                let dir = dir.clone();
                std::thread::spawn(move || {
                    let mut snapshot = empty_snapshot(device_id);
                    snapshot.records.push(Record {
                        kind: "snippets".into(),
                        id: format!("s{i}"),
                        updated_at: i,
                        deleted: false,
                        fields: json!({"body": format!("writer-{i}")}),
                    });
                    write_snapshot(&dir, device_id, &key, &snapshot).unwrap();
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }

        let devices_dir = sync_dir(&dir).join(DEVICES_DIR);
        let sealed = fs::read(devices_dir.join(format!("{device_id}.snap"))).unwrap();
        let plaintext = crypto::open(&key, &sealed).expect("final file must decrypt cleanly, not be a torn write");
        let snapshot: Snapshot = serde_json::from_slice(&plaintext).expect("final file must parse as one writer's complete snapshot");
        assert_eq!(snapshot.records.len(), 1, "must be exactly one writer's record, not a mix");

        // No stray temp files left behind by any writer.
        let leftover_tmp = fs::read_dir(&devices_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| e.path().extension().and_then(|e| e.to_str()).is_some_and(|e| e.starts_with("tmp")));
        assert!(!leftover_tmp, "no temp file should survive a completed write");
    }
}
