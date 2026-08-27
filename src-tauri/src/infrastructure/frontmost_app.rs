use crate::domain::ports::{FrontmostApplication, FrontmostAppReader};

pub struct SystemFrontmostAppReader;

impl FrontmostAppReader for SystemFrontmostAppReader {
    /// Resolves the X input focus (`linux_focus::current_focus`, walked up
    /// to its real top-level per `resolve_toplevel`'s doc comment) to a
    /// PID via `_NET_WM_PID`, then the PID to a name/path via `/proc` —
    /// no desktop-file cross-referencing (unlike `LinuxAppScanner`'s
    /// `/Applications`-equivalent scan), so `name` is the executable's
    /// file stem rather than a human app title. `bundle_id` has no Linux
    /// analogue.
    #[cfg(target_os = "linux")]
    fn frontmost_application(&self) -> Option<FrontmostApplication> {
        use crate::infrastructure::platform::linux_focus;

        let focus = linux_focus::current_focus()?;
        let toplevel = linux_focus::resolve_toplevel(focus);
        let pid = linux_focus::pid_of_window(toplevel)?;

        let exe = std::fs::read_link(format!("/proc/{pid}/exe")).ok();
        let path = exe.as_ref().and_then(|p| p.to_str()).map(String::from);
        let name = exe
            .as_deref()
            .and_then(|p| p.file_stem())
            .and_then(|s| s.to_str())
            .map(String::from)
            .or_else(|| std::fs::read_to_string(format!("/proc/{pid}/comm")).ok().map(|s| s.trim().to_string()))?;

        Some(FrontmostApplication { name, path, bundle_id: None })
    }

    /// Shells out to `osascript` (System Events) for the frontmost app's
    /// name and bundle path — the same shell-out convention this codebase
    /// already uses for every other macOS system action, rather than a
    /// new objc2 `NSWorkspace` binding this session can't locally verify
    /// compiles. `bundle_id` is read from the resolved bundle's own
    /// `Info.plist` via the `plist` crate, the identical technique
    /// `platform::macos::parse_app_bundle` already uses for the app
    /// scanner.
    #[cfg(target_os = "macos")]
    fn frontmost_application(&self) -> Option<FrontmostApplication> {
        let script = r#"tell application "System Events"
            set frontProcess to first application process whose frontmost is true
            set appName to name of frontProcess
            try
                set appPath to POSIX path of (application file of frontProcess)
            on error
                set appPath to ""
            end try
        end tell
        return appName & "\n" & appPath"#;

        let output = std::process::Command::new("osascript").args(["-e", script]).output().ok()?;
        if !output.status.success() {
            return None;
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut lines = stdout.lines();
        let name = lines.next()?.trim().to_string();
        let path = lines.next().map(str::trim).filter(|p| !p.is_empty()).map(String::from);

        let bundle_id = path.as_ref().and_then(|p| {
            let plist_path = std::path::Path::new(p).join("Contents/Info.plist");
            plist::Value::from_file(plist_path)
                .ok()?
                .as_dictionary()?
                .get("CFBundleIdentifier")?
                .as_string()
                .map(String::from)
        });

        Some(FrontmostApplication { name, path, bundle_id })
    }

    /// `GetForegroundWindow` + `GetWindowThreadProcessId` (the same pair
    /// `windows_focus::force_foreground_hwnd` already uses) resolve the
    /// focused window to a PID; `OpenProcess`/`QueryFullProcessImageNameW`
    /// resolve that PID to its executable path. `name` is the file stem,
    /// same reasoning as the Linux backend — no `FileDescription`
    /// version-resource read. No Windows bundle-id analogue.
    #[cfg(target_os = "windows")]
    fn frontmost_application(&self) -> Option<FrontmostApplication> {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
        use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

        let hwnd = unsafe { GetForegroundWindow() };
        if hwnd.0.is_null() {
            return None;
        }

        let mut pid: u32 = 0;
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
        if pid == 0 {
            return None;
        }

        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;

        let mut buf = [0u16; 1024];
        let mut len: u32 = buf.len() as u32;
        let result = unsafe { QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, windows::core::PWSTR(buf.as_mut_ptr()), &mut len) };
        let _ = unsafe { CloseHandle(handle) };
        result.ok()?;

        let path = String::from_utf16_lossy(&buf[..len as usize]);
        let name = std::path::Path::new(&path).file_stem()?.to_str()?.to_string();

        Some(FrontmostApplication { name, path: Some(path), bundle_id: None })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// No X server / no focused window is a normal headless-CI outcome —
    /// this only proves the call is safe to make at all.
    #[test]
    fn frontmost_application_does_not_panic_with_no_live_session() {
        let _ = SystemFrontmostAppReader.frontmost_application();
    }
}
