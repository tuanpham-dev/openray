//! Windows window enumeration/activation/close via Win32.
//!
//! Unverified on real hardware — this dev machine is Linux — see the
//! plan's Open Questions. Every function signature and constant used here
//! was checked directly against the `windows` crate's own generated
//! source (vendored in `~/.cargo/registry`) rather than guessed, but that
//! only confirms the bindings compile against *some* call shape — not
//! that the runtime behavior matches what the doc comments claim.

use std::ffi::c_void;

use windows::Win32::Foundation::{BOOL, CloseHandle, HWND, LPARAM, WPARAM};
use windows::Win32::Graphics::Dwm::{DWMWA_CLOAKED, DwmGetWindowAttribute};
use windows::Win32::System::Threading::{
    OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GWL_EXSTYLE, GetWindowLongW, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
    IsWindowVisible, PostMessageW, WM_CLOSE, WS_EX_TOOLWINDOW,
};
use windows::core::PWSTR;

use super::NativeWindow;
use crate::infrastructure::platform::windows_focus;

pub fn available() -> bool {
    true
}

pub fn list() -> Vec<NativeWindow> {
    let mut windows: Vec<NativeWindow> = Vec::new();
    // `EnumWindows` visits top-level windows in Z-order, topmost first —
    // already the MRU-ish order Navigation wants, no reversal needed
    // (unlike Linux's bottom-to-top `_NET_CLIENT_LIST_STACKING`).
    unsafe {
        let _ = EnumWindows(Some(enum_proc), LPARAM(std::ptr::addr_of_mut!(windows) as isize));
    }
    windows
}

unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let out = unsafe { &mut *(lparam.0 as *mut Vec<NativeWindow>) };
    if let Some(window) = describe_window(hwnd) {
        out.push(window);
    }
    BOOL(1)
}

fn describe_window(hwnd: HWND) -> Option<NativeWindow> {
    let own_pid = std::process::id();
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    if pid == own_pid {
        return None;
    }

    if !unsafe { IsWindowVisible(hwnd) }.as_bool() {
        return None;
    }

    let ex_style = unsafe { GetWindowLongW(hwnd, GWL_EXSTYLE) } as u32;
    if ex_style & WS_EX_TOOLWINDOW.0 != 0 {
        return None;
    }

    if is_cloaked(hwnd) {
        return None;
    }

    let title = window_title(hwnd)?;
    if title.is_empty() {
        return None;
    }

    let app_name = process_exe_stem(pid).unwrap_or_default();

    Some(NativeWindow {
        id: (hwnd.0 as isize).to_string(),
        title,
        // No icon-extraction path implemented on Windows (disclosed scope
        // trim — see the plan) and `WindowsAppScanner` never sets icons
        // either, so `application::navigation`'s app-icon match can't
        // help here; every window falls back to the frontend's
        // initial-letter avatar.
        app_match_hint: app_name.to_lowercase(),
        app_name,
        icon: None,
    })
}

/// A window can be visible by every `WS_VISIBLE`/`IsWindowVisible` measure
/// and still not actually be on screen — DWM "cloaks" windows on inactive
/// virtual desktops and some UWP host windows, and those shouldn't show
/// up as switchable.
fn is_cloaked(hwnd: HWND) -> bool {
    let mut cloaked: u32 = 0;
    let ok = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            (&mut cloaked as *mut u32).cast::<c_void>(),
            std::mem::size_of::<u32>() as u32,
        )
    };
    ok.is_ok() && cloaked != 0
}

fn window_title(hwnd: HWND) -> Option<String> {
    let len = unsafe { GetWindowTextLengthW(hwnd) };
    if len <= 0 {
        return None;
    }
    let mut buf = vec![0u16; len as usize + 1];
    let copied = unsafe { GetWindowTextW(hwnd, &mut buf) };
    if copied <= 0 {
        return None;
    }
    Some(String::from_utf16_lossy(&buf[..copied as usize]))
}

fn process_exe_stem(pid: u32) -> Option<String> {
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
    let mut buf = [0u16; 512];
    let mut len = buf.len() as u32;
    let result = unsafe { QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len) };
    let _ = unsafe { CloseHandle(handle) };
    result.ok()?;

    let path = String::from_utf16_lossy(&buf[..len as usize]);
    std::path::Path::new(&path).file_stem().and_then(|s| s.to_str()).map(String::from)
}

fn hwnd_from_id(id: &str) -> Option<HWND> {
    let raw: isize = id.parse().ok()?;
    Some(HWND(raw as *mut c_void))
}

pub fn activate(id: &str) -> bool {
    let Some(hwnd) = hwnd_from_id(id) else { return false };
    // `force_foreground_hwnd` already performs the attach-thread-input +
    // `SetForegroundWindow` dance `windows_focus` uses to bring the
    // palette itself forward — reused as-is for an arbitrary target.
    windows_focus::force_foreground_hwnd(hwnd);
    true
}

pub fn close(id: &str) -> bool {
    let Some(hwnd) = hwnd_from_id(id) else { return false };
    unsafe { PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0)) }.is_ok()
}
