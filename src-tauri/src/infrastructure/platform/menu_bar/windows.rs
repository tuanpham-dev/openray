//! Classic Win32 menu (`HMENU`) reading/activation.
//!
//! Covers apps with a real `GetMenu`-visible menu bar (Notepad++, many
//! classic Win32/MFC/WinForms apps). UWP, Electron, and Office's ribbon
//! don't expose one this way — `GetMenu` returns null and the empty
//! state kicks in, same as any other unsupported app (UIAutomation, which
//! *could* reach those, is deliberately out of scope for this pass).
//!
//! Unverified on real hardware — this dev machine is Linux — see the
//! plan's Open Questions. Every signature/constant used here was checked
//! against the `windows` crate's own generated source, not guessed.

use std::ffi::c_void;

use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    GetMenu, GetMenuItemCount, GetMenuItemInfoW, GetWindowTextLengthW, GetWindowTextW, HMENU, MENUITEMINFOW,
    MFS_DISABLED, MFT_SEPARATOR, MIIM_FTYPE, MIIM_ID, MIIM_STATE, MIIM_STRING, MIIM_SUBMENU, PostMessageW, WM_COMMAND,
};

use super::{MenuBarRead, RawMenuNode};
use crate::infrastructure::platform::windows_focus;

pub fn available() -> bool {
    true
}

pub fn read() -> MenuBarRead {
    read_inner().unwrap_or_default()
}

fn read_inner() -> Option<MenuBarRead> {
    let hwnd = HWND(windows_focus::previously_foreground_hwnd()? as *mut c_void);
    let app_name = window_title(hwnd);

    let menu = unsafe { GetMenu(hwnd) };
    if menu.0.is_null() {
        return Some(MenuBarRead { app_name, nodes: Vec::new() });
    }

    Some(MenuBarRead { app_name, nodes: read_menu(menu, hwnd) })
}

fn window_title(hwnd: HWND) -> Option<String> {
    let len = unsafe { GetWindowTextLengthW(hwnd) };
    if len <= 0 {
        return None;
    }
    let mut buf = vec![0u16; len as usize + 1];
    let copied = unsafe { GetWindowTextW(hwnd, &mut buf) };
    (copied > 0).then(|| String::from_utf16_lossy(&buf[..copied as usize]))
}

fn read_menu(menu: HMENU, hwnd: HWND) -> Vec<RawMenuNode> {
    let count = unsafe { GetMenuItemCount(Some(menu)) };
    if count <= 0 {
        return Vec::new();
    }

    (0..count as u32).filter_map(|index| read_menu_item(menu, index, hwnd)).collect()
}

fn read_menu_item(menu: HMENU, index: u32, hwnd: HWND) -> Option<RawMenuNode> {
    let mut buf = [0u16; 256];
    let mut info = MENUITEMINFOW {
        cbSize: std::mem::size_of::<MENUITEMINFOW>() as u32,
        fMask: MIIM_STRING | MIIM_STATE | MIIM_SUBMENU | MIIM_FTYPE | MIIM_ID,
        dwTypeData: windows::core::PWSTR(buf.as_mut_ptr()),
        cch: buf.len() as u32,
        ..Default::default()
    };

    if unsafe { GetMenuItemInfoW(menu, index, true, &mut info) }.is_err() {
        return None;
    }

    if info.fType.contains(MFT_SEPARATOR) {
        return Some(RawMenuNode::Separator);
    }

    let raw_title = wide_buf_to_string(&buf);
    let title = strip_accelerator_and_mnemonic(&raw_title);
    let enabled = !info.fState.contains(MFS_DISABLED);

    if !info.hSubMenu.0.is_null() {
        let children = read_menu(info.hSubMenu, hwnd);
        if title.is_empty() && children.is_empty() {
            return None;
        }
        return Some(RawMenuNode::Submenu { title, enabled, children });
    }

    if title.is_empty() {
        return None;
    }

    let shortcut = raw_title.split_once('\t').map(|(_, accel)| accel.to_string()).filter(|s| !s.is_empty());
    let token = format!("win32:{}:{}", hwnd.0 as isize, info.wID);

    Some(RawMenuNode::Item { title, enabled, shortcut, token })
}

fn wide_buf_to_string(buf: &[u16]) -> String {
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..len])
}

/// Win32 menu strings pack both the mnemonic (`&File`) and, for leaf
/// items, an accelerator hint after a tab (`Save\tCtrl+S`) into the same
/// string. The accelerator is split off separately as the shortcut
/// accessory (see `read_menu_item`); this only strips the `&`.
fn strip_accelerator_and_mnemonic(raw: &str) -> String {
    let title = raw.split('\t').next().unwrap_or(raw);
    let mut out = String::with_capacity(title.len());
    let mut chars = title.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '&' && chars.peek() == Some(&'&') {
            out.push(chars.next().unwrap());
        } else if c == '&' {
            continue;
        } else {
            out.push(c);
        }
    }
    out.trim().to_string()
}

pub fn activate(token: &str) -> bool {
    activate_inner(token).is_some()
}

fn activate_inner(token: &str) -> Option<()> {
    let rest = token.strip_prefix("win32:")?;
    let (hwnd_str, cmd_str) = rest.split_once(':')?;
    let hwnd_raw: isize = hwnd_str.parse().ok()?;
    let cmd_id: u32 = cmd_str.parse().ok()?;

    let hwnd = HWND(hwnd_raw as *mut c_void);
    unsafe { PostMessageW(Some(hwnd), WM_COMMAND, WPARAM(cmd_id as usize), LPARAM(0)) }.ok()
}
