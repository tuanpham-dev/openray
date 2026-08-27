//! Win32 window-geometry backend.
//!
//! Unverified on real hardware — this dev machine is Linux — see the
//! plan's Constraints. Every signature used here follows `window_list`/
//! `windows_focus`'s existing conventions and was checked against the
//! `windows` crate's generated source, not guessed.

use std::ffi::c_void;

use windows::Win32::Foundation::{BOOL, HWND, LPARAM, RECT};
use windows::Win32::Graphics::Dwm::{DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute};
use windows::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromWindow,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowRect, GetWindowThreadProcessId, IsZoomed, SW_RESTORE, SWP_NOACTIVATE, SWP_NOZORDER,
    SetWindowPos, ShowWindow,
};

use super::Rect;
use crate::infrastructure::platform::windows_focus;

pub fn available() -> bool {
    true
}

fn is_own_window(hwnd: HWND) -> bool {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    pid == std::process::id()
}

/// The previously-foreground window if the palette (or another of our own
/// windows) currently holds foreground status, otherwise whatever's
/// foreground right now — covers both the palette-open and hotkey
/// invocation paths, the Windows analogue of Linux's `target()`. Never
/// returns one of our own windows (see `linux.rs`'s `target()` for why
/// that guard matters — the same "palette was open over our own Settings
/// window" scenario applies here).
pub fn target() -> Option<String> {
    let current = unsafe { GetForegroundWindow() };
    let hwnd = if !current.0.is_null() && is_own_window(current) {
        HWND(windows_focus::previously_foreground_hwnd()? as *mut c_void)
    } else if !current.0.is_null() {
        current
    } else {
        return None;
    };

    if is_own_window(hwnd) {
        return None;
    }
    Some((hwnd.0 as isize).to_string())
}

fn hwnd_from_id(id: &str) -> Option<HWND> {
    let raw: isize = id.parse().ok()?;
    Some(HWND(raw as *mut c_void))
}

fn dwm_frame_bounds(hwnd: HWND) -> Option<RECT> {
    let mut rect = RECT::default();
    let ok = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            (&mut rect as *mut RECT).cast::<c_void>(),
            std::mem::size_of::<RECT>() as u32,
        )
    };
    ok.is_ok().then_some(rect)
}

pub fn frame(id: &str) -> Option<Rect> {
    let hwnd = hwnd_from_id(id)?;
    let r = dwm_frame_bounds(hwnd)?;
    Some(Rect { x: r.left as f64, y: r.top as f64, w: (r.right - r.left) as f64, h: (r.bottom - r.top) as f64 })
}

/// Per-edge (`GetWindowRect` minus `DWMWA_EXTENDED_FRAME_BOUNDS`) — Windows
/// 10/11 pad the real window rect (what `SetWindowPos` positions) with a
/// few pixels of invisible resize border beyond the visually-apparent
/// frame (what `frame()` reports and every layout preset computes
/// against). Without correcting for it, every placement lands a few
/// pixels short on the left/right/bottom — the classic naive-`SetWindowPos`
/// bug.
struct EdgeDelta {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

fn frame_delta(hwnd: HWND) -> Option<EdgeDelta> {
    let mut window_rect = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut window_rect) }.ok()?;
    let dwm_rect = dwm_frame_bounds(hwnd)?;

    Some(EdgeDelta {
        left: window_rect.left - dwm_rect.left,
        top: window_rect.top - dwm_rect.top,
        right: window_rect.right - dwm_rect.right,
        bottom: window_rect.bottom - dwm_rect.bottom,
    })
}

/// Pure: the `SetWindowPos` (window-rect-space) x/y/w/h that lands the
/// window's *visible* (DWM) frame at `target`, given the edge delta
/// measured from the window's current state.
fn windowpos_rect(target: Rect, delta: &EdgeDelta) -> (i32, i32, i32, i32) {
    let x = (target.x + delta.left as f64).round() as i32;
    let y = (target.y + delta.top as f64).round() as i32;
    let w = (target.w - delta.left as f64 + delta.right as f64).round().max(1.0) as i32;
    let h = (target.h - delta.top as f64 + delta.bottom as f64).round().max(1.0) as i32;
    (x, y, w, h)
}

pub fn set_frame(id: &str, rect: Rect) -> bool {
    let Some(hwnd) = hwnd_from_id(id) else { return false };

    if unsafe { IsZoomed(hwnd) }.as_bool() {
        unsafe {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
    }

    let Some(delta) = frame_delta(hwnd) else { return false };
    let (x, y, w, h) = windowpos_rect(rect, &delta);
    unsafe { SetWindowPos(hwnd, None, x, y, w, h, SWP_NOZORDER | SWP_NOACTIVATE) }.is_ok()
}

fn monitor_rect(handle: HMONITOR) -> Option<Rect> {
    let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
    unsafe { GetMonitorInfoW(handle, &mut info) }.ok()?;
    let r = info.rcMonitor;
    Some(Rect { x: r.left as f64, y: r.top as f64, w: (r.right - r.left) as f64, h: (r.bottom - r.top) as f64 })
}

pub fn work_area(id: &str) -> Option<Rect> {
    let hwnd = hwnd_from_id(id)?;
    let handle = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
    let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
    unsafe { GetMonitorInfoW(handle, &mut info) }.ok()?;
    let r = info.rcWork;
    Some(Rect { x: r.left as f64, y: r.top as f64, w: (r.right - r.left) as f64, h: (r.bottom - r.top) as f64 })
}

pub fn displays() -> Vec<Rect> {
    let mut monitors: Vec<Rect> = Vec::new();
    unsafe {
        let _ = EnumDisplayMonitors(None, None, Some(enum_monitor_proc), LPARAM(std::ptr::addr_of_mut!(monitors) as isize));
    }
    monitors
}

unsafe extern "system" fn enum_monitor_proc(handle: HMONITOR, _hdc: HDC, _rect: *mut RECT, lparam: LPARAM) -> BOOL {
    let out = unsafe { &mut *(lparam.0 as *mut Vec<Rect>) };
    if let Some(rect) = monitor_rect(handle) {
        out.push(rect);
    }
    BOOL(1)
}

/// Not supported by this backend (no classic Win32 fullscreen API this
/// pass implements — see the plan's Approach) — the command itself is
/// hidden from search on Windows, so this should never actually be
/// called, but degrades to a clean no-op rather than a panic if it is.
pub fn set_fullscreen(_id: &str, _fullscreen: bool) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windowpos_rect_compensates_for_asymmetric_invisible_borders() {
        // left border 7px, right border 7px, top border 0px, bottom
        // border 7px — a typical Windows 10/11 shape.
        let delta = EdgeDelta { left: -7, top: 0, right: 7, bottom: 7 };
        let target = Rect { x: 100.0, y: 50.0, w: 200.0, h: 300.0 };
        let (x, y, w, h) = windowpos_rect(target, &delta);
        assert_eq!(x, 93);
        assert_eq!(y, 50);
        assert_eq!(w, 214);
        assert_eq!(h, 307);
    }

    #[test]
    fn windowpos_rect_is_a_no_op_with_zero_delta() {
        let delta = EdgeDelta { left: 0, top: 0, right: 0, bottom: 0 };
        let target = Rect { x: 10.0, y: 20.0, w: 300.0, h: 400.0 };
        let (x, y, w, h) = windowpos_rect(target, &delta);
        assert_eq!((x, y, w, h), (10, 20, 300, 400));
    }
}
