//! Video thumbnail extraction — shells out to `ffmpeg` for one frame, the
//! same "optional external tool" pattern `platform::ocr::linux` uses for
//! `tesseract`. Unlike OCR, ffmpeg's invocation is identical on every
//! platform, so this lives as one cross-platform module rather than
//! under `platform/` with per-OS backends.
//!
//! Best-effort by design: a missing `ffmpeg`, or one that fails on a
//! specific file, just means that video keeps the grid's existing
//! film-icon placeholder — never a hard error the caller has to handle
//! specially (see `application::screenshots::run_index_sweep`).

use std::collections::hash_map::DefaultHasher;
use std::ffi::OsString;
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::process::Command;
use std::sync::OnceLock;

use crate::error::Error;

/// Whether `ffmpeg` is reachable on `$PATH` — probed once and cached,
/// since spawning a process just to check availability on every sweep
/// tick would be wasteful.
pub fn available() -> bool {
    static AVAILABLE: OnceLock<bool> = OnceLock::new();
    *AVAILABLE.get_or_init(|| Command::new("ffmpeg").arg("-version").output().map(|o| o.status.success()).unwrap_or(false))
}

/// Extracts one frame from `src` into `dst` as a small JPEG. Creates
/// `dst`'s parent directory if needed. `dst` is left untouched (not
/// created, not truncated) on failure, so a caller checking `dst.exists()`
/// afterward can't be fooled by a zero-byte file.
pub fn generate(src: &Path, dst: &Path) -> Result<(), Error> {
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let output = Command::new("ffmpeg").args(ffmpeg_args(src, dst)).output()?;

    if !output.status.success() || !dst.exists() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail: String = stderr.lines().rev().take(3).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join(" | ");
        return Err(Error::msg(format!("ffmpeg failed: {tail}")));
    }

    Ok(())
}

/// `-vf scale='min(320,iw)':-2` caps width at 320px (grid cells render
/// around 150px; this leaves room for HiDPI without keeping full-size
/// frames) while `-2` keeps height even, which some encoders require.
/// `-frames:v 1` stops after the first decoded frame — no need to read
/// further into the file. `-q:v 5` is a mid-range JPEG quality, small
/// enough that a folder of recordings doesn't balloon the cache dir.
fn ffmpeg_args(src: &Path, dst: &Path) -> Vec<OsString> {
    vec![
        "-y".into(),
        "-loglevel".into(),
        "error".into(),
        "-i".into(),
        src.into(),
        "-frames:v".into(),
        "1".into(),
        "-vf".into(),
        "scale='min(320,iw)':-2".into(),
        "-q:v".into(),
        "5".into(),
        dst.into(),
    ]
}

/// Deterministic-within-this-process cache filename for `path` — same
/// hashing idiom `clipboard_watcher::hash_bytes` uses for pasted images.
/// Lookups always go through the `screenshot_thumbnails` DB row rather
/// than re-deriving this, so `DefaultHasher`'s unspecified cross-run
/// stability (e.g. across a Rust upgrade) only orphans an old file
/// rather than breaking a lookup.
pub fn thumb_filename(path: &str) -> String {
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    format!("{}.jpg", hasher.finish())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn ffmpeg_args_orders_source_then_single_frame_then_dest() {
        let args = ffmpeg_args(Path::new("/tmp/in.mp4"), Path::new("/tmp/out.jpg"));
        let strs: Vec<String> = args.iter().map(|a| a.to_string_lossy().into_owned()).collect();

        let i_pos = strs.iter().position(|s| s == "-i").unwrap();
        assert_eq!(strs[i_pos + 1], "/tmp/in.mp4");

        let frames_pos = strs.iter().position(|s| s == "-frames:v").unwrap();
        assert_eq!(strs[frames_pos + 1], "1");

        assert_eq!(strs.last().unwrap(), "/tmp/out.jpg");
    }

    #[test]
    fn thumb_filename_is_deterministic_and_ends_in_jpg() {
        let a = thumb_filename("/home/user/Videos/clip.mp4");
        let b = thumb_filename("/home/user/Videos/clip.mp4");
        assert_eq!(a, b);
        assert!(a.ends_with(".jpg"));
    }

    #[test]
    fn thumb_filename_differs_for_different_paths() {
        assert_ne!(thumb_filename("/a/one.mp4"), thumb_filename("/a/two.mp4"));
    }

    #[test]
    fn generate_returns_err_for_a_nonexistent_source_without_creating_dst() {
        // Only run this if ffmpeg is actually present — otherwise this
        // would just be testing the "ffmpeg not found" path, which is a
        // different failure mode than what this test targets.
        if !available() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("openray-video-thumbs-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("does-not-exist.mp4");
        let dst = dir.join("out.jpg");

        let result = generate(&src, &dst);

        assert!(result.is_err());
        assert!(!dst.exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn generate_extracts_a_frame_from_a_real_video_when_ffmpeg_is_available() {
        if !available() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("openray-video-thumbs-test2-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("in.mp4");
        let dst = dir.join("nested").join("out.jpg");

        let made = Command::new("ffmpeg")
            .args(["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=64x64:rate=5:duration=1"])
            .arg(&src)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !made {
            std::fs::remove_dir_all(&dir).ok();
            return;
        }

        let result = generate(&src, &dst);

        assert!(result.is_ok(), "{result:?}");
        assert!(dst.exists());
        assert!(PathBuf::from(&dst).metadata().unwrap().len() > 0);
        std::fs::remove_dir_all(&dir).ok();
    }
}
