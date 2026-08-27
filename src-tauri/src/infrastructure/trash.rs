use crate::domain::ports::Trash;

pub struct SystemTrash;

impl Trash for SystemTrash {
    /// `gio trash` (GLib's own trash implementation, already the
    /// established shell-out choice elsewhere in this codebase — see
    /// `application::system_commands`'s trash-related entries) moves
    /// `path` to the freedesktop trash rather than deleting it outright.
    #[cfg(target_os = "linux")]
    fn trash(&self, path: &str) -> Result<(), String> {
        let output = std::process::Command::new("gio")
            .args(["trash", path])
            .output()
            .map_err(|e| e.to_string())?;
        if output.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
        }
    }

    /// Shells out to Finder via `osascript`, matching this codebase's
    /// existing convention for macOS system actions (`system_commands`'s
    /// `mac_osascript` helper) over a direct `NSFileManager` binding —
    /// consistent with every other macOS action already in this crate,
    /// and avoids adding a new Objective-C call surface for one method.
    #[cfg(target_os = "macos")]
    fn trash(&self, path: &str) -> Result<(), String> {
        let script = format!(
            "tell application \"Finder\" to delete POSIX file \"{}\"",
            path.replace('\\', "\\\\").replace('"', "\\\"")
        );
        let output = std::process::Command::new("osascript")
            .args(["-e", &script])
            .output()
            .map_err(|e| e.to_string())?;
        if output.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
        }
    }

    #[cfg(target_os = "windows")]
    fn trash(&self, path: &str) -> Result<(), String> {
        use windows::Win32::UI::Shell::{
            SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FO_DELETE, SHFILEOPSTRUCTW,
        };
        use windows::core::PCWSTR;

        // pFrom is a list of null-terminated strings, itself terminated by
        // a second, trailing null — a single-entry list is `path\0\0`.
        let mut from: Vec<u16> = path.encode_utf16().collect();
        from.push(0);
        from.push(0);

        let flags = FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT;
        let mut op = SHFILEOPSTRUCTW {
            wFunc: FO_DELETE,
            pFrom: PCWSTR(from.as_ptr()),
            fFlags: flags.0 as u16,
            ..Default::default()
        };

        let result = unsafe { SHFileOperationW(&mut op) };
        if result == 0 {
            Ok(())
        } else {
            Err(format!("SHFileOperationW failed with code {result}"))
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    fn gio_available() -> bool {
        std::process::Command::new("gio").arg("--version").output().map(|o| o.status.success()).unwrap_or(false)
    }

    /// A directory under `$HOME` rather than `std::env::temp_dir()` — the
    /// freedesktop trash spec (and `gio`'s enforcement of it) requires the
    /// file and its `.Trash`/`.Trash-$uid` directory to share a mount;
    /// `/tmp` is very often a separate tmpfs mount and `gio trash` refuses
    /// it outright ("Trashing on system internal mounts is not
    /// supported") — confirmed empirically in this sandbox.
    fn home_scoped_test_dir() -> Option<std::path::PathBuf> {
        let home = std::env::var_os("HOME")?;
        Some(std::path::PathBuf::from(home).join(format!(".openray-trash-test-{}", std::process::id())))
    }

    #[test]
    fn trashing_a_real_file_removes_it_from_its_original_path() {
        if !gio_available() {
            return;
        }
        let Some(dir) = home_scoped_test_dir() else { return };
        std::fs::create_dir_all(&dir).unwrap();
        // A name unique per test run (not just the containing directory) —
        // this really lands in the user's real trash can, and a fixed
        // name would let repeated runs pile up entries there indefinitely
        // (gio disambiguates a collision by renaming, which would also
        // break the direct cleanup path below).
        let name = format!("openray-trash-test-{}.txt", crate::infrastructure::time::now_nanos());
        let file = dir.join(&name);
        std::fs::write(&file, b"content").unwrap();

        let result = SystemTrash.trash(file.to_str().unwrap());
        let still_exists = file.exists();
        let _ = std::fs::remove_dir_all(&dir);

        // Best-effort: clean up the copy `gio trash` just made in the
        // user's real trash can, so running this test doesn't leave
        // artifacts behind indefinitely. Not asserted — a failure here
        // must not fail the test that already got its real assertion.
        if let Some(home) = std::env::var_os("HOME") {
            let trash_dir = std::path::PathBuf::from(home).join(".local/share/Trash");
            let _ = std::fs::remove_file(trash_dir.join("files").join(&name));
            let _ = std::fs::remove_file(trash_dir.join("info").join(format!("{name}.trashinfo")));
        }

        result.unwrap();
        assert!(!still_exists, "trashed file must no longer exist at its original path");
    }

    #[test]
    fn trashing_a_nonexistent_path_fails() {
        if !gio_available() {
            return;
        }
        let missing = std::env::temp_dir().join(format!("openray-trash-test-missing-{}", std::process::id()));
        assert!(SystemTrash.trash(missing.to_str().unwrap()).is_err());
    }
}
