//! X11/EWMH window-geometry backend.
//!
//! **T4 probe outcome (recorded before the rest of this file was built):**
//! `_NET_MOVERESIZE_WINDOW` works on this machine's window manager (XFWM).
//! Verified live: left-halving a real terminal window landed the frame
//! flush at the work-area edge once frame-extent compensation (via
//! `_NET_FRAME_EXTENTS`, StaticGravity) was applied to convert the desired
//! *frame* rect into the client-relative x/y/w/h the protocol expects.
//! Two findings from the probe, folded into the implementation below:
//! (1) XFWM ignores `_NET_MOVERESIZE_WINDOW` on an already-maximized
//! window — `set_frame` removes `_NET_WM_STATE_MAXIMIZED_HORZ`/`_VERT`
//! first. (2) `_NET_WORKAREA` on this XFCE session is a per-desktop array,
//! not a single rect — `work_area` indexes it by `_NET_CURRENT_DESKTOP`.
//!
//! Everything here is best-effort, matching `window_list`'s philosophy:
//! failures return `None`/`false` rather than erroring.

use x11rb::connection::Connection;
use x11rb::protocol::randr::ConnectionExt as RandrConnectionExt;
use x11rb::protocol::xproto::{Atom, AtomEnum, ClientMessageEvent, ConnectionExt, EventMask};

use super::Rect;
use crate::infrastructure::platform::linux_focus;

pub fn available() -> bool {
    x11rb::connect(None).is_ok()
}

/// The window a command should act on. Tries three sources in priority
/// order and returns the first one that resolves to a window that isn't
/// one of our own (the palette, or — the T6-found bug — our own Settings
/// window): the live X input focus (covers the hotkey path, where the
/// palette never shows at all); the focus remembered just before the
/// palette last opened (covers the palette-open path, where the palette
/// itself now holds real X focus); and `_NET_ACTIVE_WINDOW`, the window
/// manager's own independently-maintained "active window" — not tied to X
/// input-focus tracking at all, so it isn't cleared by our own
/// hide-then-restore cycle the way the remembered-focus source is.
///
/// That third source exists because of a live bug report: a fast
/// palette-reopen can race the *previous* command's `hide_palette`, whose
/// `restore_focus` call both clears the remembered focus (it's consumed
/// via `.take()`) and hasn't yet landed at the X server — so at the
/// moment the new `remember_focused_window()` runs, X input focus is
/// transiently still the palette itself, with nothing else recorded.
/// `_NET_ACTIVE_WINDOW` sidesteps the race entirely: XFWM updates it
/// independently of whatever we've done to X input focus.
pub fn target() -> Option<String> {
    let candidates = [linux_focus::current_focus(), linux_focus::previously_focused_window(), active_window_from_wm()];

    candidates
        .into_iter()
        .flatten()
        .map(linux_focus::resolve_toplevel)
        .find(|&id| !linux_focus::is_own_window(id))
        .map(|id| id.to_string())
}

fn active_window_from_wm() -> Option<u32> {
    let (conn, screen_num) = x11rb::connect(None).ok()?;
    let root = conn.setup().roots.get(screen_num)?.root;
    let atom = intern(&conn, b"_NET_ACTIVE_WINDOW")?;
    let win = conn.get_property(false, root, atom, AtomEnum::WINDOW, 0, 1).ok()?.reply().ok()?.value32()?.next()?;
    (win != 0).then_some(win)
}

pub fn frame(id: &str) -> Option<Rect> {
    frame_inner(id)
}

fn frame_inner(id: &str) -> Option<Rect> {
    let win: u32 = id.parse().ok()?;
    let (conn, screen_num) = x11rb::connect(None).ok()?;
    let root = conn.setup().roots.get(screen_num)?.root;
    let (cx, cy, cw, ch) = client_geometry(&conn, root, win)?;
    let ext = frame_extents(&conn, win);
    Some(frame_from_client(cx, cy, cw, ch, ext))
}

pub fn set_frame(id: &str, rect: Rect) -> bool {
    set_frame_inner(id, rect).is_some()
}

fn set_frame_inner(id: &str, rect: Rect) -> Option<()> {
    let win: u32 = id.parse().ok()?;
    let (conn, screen_num) = x11rb::connect(None).ok()?;
    let root = conn.setup().roots.get(screen_num)?.root;

    // XFWM (and most WMs) silently ignore _NET_MOVERESIZE_WINDOW on an
    // already-maximized window — confirmed live during the T4 probe.
    unmaximize(&conn, root, win);

    let ext = frame_extents(&conn, win);
    let (client_x, client_y, client_w, client_h) = client_from_frame(rect, ext);
    moveresize(&conn, root, win, client_x.round() as i32, client_y.round() as i32, client_w.round() as u32, client_h.round() as u32)
}

pub fn work_area(id: &str) -> Option<Rect> {
    work_area_inner(id)
}

fn work_area_inner(id: &str) -> Option<Rect> {
    let (conn, screen_num) = x11rb::connect(None).ok()?;
    let root = conn.setup().roots.get(screen_num)?.root;
    let desktop_area = desktop_work_area(&conn, root)?;

    let monitors = displays_inner(&conn, root).unwrap_or_default();
    if monitors.len() <= 1 {
        return Some(desktop_area);
    }

    // Multi-monitor path: intersect the whole-desktop work area with
    // whichever RandR monitor contains the target window's center. Can't
    // be exercised live on this single-monitor machine — reviewed, not
    // verified; see the plan's on-device notes.
    let win_frame = frame_inner(id).unwrap_or(desktop_area);
    let cx = win_frame.x + win_frame.w / 2.0;
    let cy = win_frame.y + win_frame.h / 2.0;
    let monitor = monitors.iter().find(|m| point_in_rect(cx, cy, **m)).copied().unwrap_or(monitors[0]);
    Some(intersect(monitor, desktop_area))
}

pub fn displays() -> Vec<Rect> {
    let Ok((conn, screen_num)) = x11rb::connect(None) else { return Vec::new() };
    let Some(root) = conn.setup().roots.get(screen_num).map(|s| s.root) else { return Vec::new() };
    displays_inner(&conn, root).unwrap_or_default()
}

fn displays_inner(conn: &impl Connection, root: u32) -> Option<Vec<Rect>> {
    let monitors = conn.randr_get_monitors(root, true).ok()?.reply().ok()?;
    Some(monitors.monitors.into_iter().map(|m| Rect { x: m.x as f64, y: m.y as f64, w: m.width as f64, h: m.height as f64 }).collect())
}

pub fn set_fullscreen(id: &str, fullscreen: bool) -> bool {
    set_fullscreen_inner(id, fullscreen).is_some()
}

fn set_fullscreen_inner(id: &str, fullscreen: bool) -> Option<()> {
    let win: u32 = id.parse().ok()?;
    let (conn, screen_num) = x11rb::connect(None).ok()?;
    let root = conn.setup().roots.get(screen_num)?.root;
    let state_atom = intern(&conn, b"_NET_WM_STATE")?;
    let fs_atom = intern(&conn, b"_NET_WM_STATE_FULLSCREEN")?;
    const ACTION_ADD: u32 = 1;
    const ACTION_REMOVE: u32 = 0;
    let action = if fullscreen { ACTION_ADD } else { ACTION_REMOVE };
    let event = ClientMessageEvent::new(32, win, state_atom, [action, fs_atom, 0, 2, 0]);
    conn.send_event(false, root, EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY, event).ok()?;
    conn.flush().ok()?;
    Some(())
}

// ---- EWMH plumbing -----------------------------------------------------

fn intern(conn: &impl Connection, name: &[u8]) -> Option<Atom> {
    conn.intern_atom(false, name).ok()?.reply().ok().map(|r| r.atom)
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
struct FrameExtents {
    left: i32,
    right: i32,
    top: i32,
    bottom: i32,
}

fn frame_extents(conn: &impl Connection, win: u32) -> FrameExtents {
    frame_extents_inner(conn, win).unwrap_or_default()
}

fn frame_extents_inner(conn: &impl Connection, win: u32) -> Option<FrameExtents> {
    let atom = intern(conn, b"_NET_FRAME_EXTENTS")?;
    let reply = conn.get_property(false, win, atom, AtomEnum::CARDINAL, 0, 4).ok()?.reply().ok()?;
    let mut values = reply.value32()?;
    Some(FrameExtents { left: values.next()? as i32, right: values.next()? as i32, top: values.next()? as i32, bottom: values.next()? as i32 })
}

fn client_geometry(conn: &impl Connection, root: u32, win: u32) -> Option<(f64, f64, f64, f64)> {
    let geom = conn.get_geometry(win).ok()?.reply().ok()?;
    let translated = conn.translate_coordinates(win, root, 0, 0).ok()?.reply().ok()?;
    Some((translated.dst_x as f64, translated.dst_y as f64, geom.width as f64, geom.height as f64))
}

/// Pure: the window's *frame* rect (including decorations) from its
/// client-area geometry and frame extents.
fn frame_from_client(cx: f64, cy: f64, cw: f64, ch: f64, ext: FrameExtents) -> Rect {
    Rect { x: cx - ext.left as f64, y: cy - ext.top as f64, w: cw + (ext.left + ext.right) as f64, h: ch + (ext.top + ext.bottom) as f64 }
}

/// Pure: the client-relative (x, y, w, h) `_NET_MOVERESIZE_WINDOW` needs
/// (StaticGravity — x/y address the client, not the frame) to land the
/// window's *frame* at `rect`. Inverse of `frame_from_client`.
fn client_from_frame(rect: Rect, ext: FrameExtents) -> (f64, f64, f64, f64) {
    (
        rect.x + ext.left as f64,
        rect.y + ext.top as f64,
        (rect.w - (ext.left + ext.right) as f64).max(1.0),
        (rect.h - (ext.top + ext.bottom) as f64).max(1.0),
    )
}

fn desktop_work_area(conn: &impl Connection, root: u32) -> Option<Rect> {
    let desktop = current_desktop(conn, root).unwrap_or(0);
    let atom = intern(conn, b"_NET_WORKAREA")?;
    let reply = conn.get_property(false, root, atom, AtomEnum::CARDINAL, 0, 4096).ok()?.reply().ok()?;
    let values: Vec<u32> = reply.value32()?.collect();
    workarea_rect_for_desktop(&values, desktop)
}

/// Pure: `_NET_WORKAREA` is `x, y, w, h` per virtual desktop, concatenated
/// — not always a single rect (this XFCE session publishes one entry per
/// desktop, confirmed during the T4 probe), so index by the current one.
fn workarea_rect_for_desktop(values: &[u32], desktop: u32) -> Option<Rect> {
    let idx = desktop as usize * 4;
    if values.len() < idx + 4 {
        return None;
    }
    Some(Rect { x: values[idx] as f64, y: values[idx + 1] as f64, w: values[idx + 2] as f64, h: values[idx + 3] as f64 })
}

fn current_desktop(conn: &impl Connection, root: u32) -> Option<u32> {
    let atom = intern(conn, b"_NET_CURRENT_DESKTOP")?;
    conn.get_property(false, root, atom, AtomEnum::CARDINAL, 0, 1).ok()?.reply().ok()?.value32()?.next()
}

fn point_in_rect(x: f64, y: f64, r: Rect) -> bool {
    x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h
}

fn intersect(a: Rect, b: Rect) -> Rect {
    let x = a.x.max(b.x);
    let y = a.y.max(b.y);
    let right = (a.x + a.w).min(b.x + b.w);
    let bottom = (a.y + a.h).min(b.y + b.h);
    Rect { x, y, w: (right - x).max(0.0), h: (bottom - y).max(0.0) }
}

fn unmaximize(conn: &impl Connection, root: u32, win: u32) -> Option<()> {
    let state_atom = intern(conn, b"_NET_WM_STATE")?;
    let horz = intern(conn, b"_NET_WM_STATE_MAXIMIZED_HORZ")?;
    let vert = intern(conn, b"_NET_WM_STATE_MAXIMIZED_VERT")?;
    const ACTION_REMOVE: u32 = 0;
    let event = ClientMessageEvent::new(32, win, state_atom, [ACTION_REMOVE, horz, vert, 2, 0]);
    conn.send_event(false, root, EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY, event).ok()?;
    conn.flush().ok()?;
    Some(())
}

fn moveresize(conn: &impl Connection, root: u32, win: u32, x: i32, y: i32, w: u32, h: u32) -> Option<()> {
    let atom = intern(conn, b"_NET_MOVERESIZE_WINDOW")?;
    const STATIC_GRAVITY: u32 = 10;
    const FLAGS_X_Y_W_H_PRESENT: u32 = 0b1111 << 8;
    const SOURCE_PAGER: u32 = 2 << 12;
    let gravity_and_flags = STATIC_GRAVITY | FLAGS_X_Y_W_H_PRESENT | SOURCE_PAGER;
    let event = ClientMessageEvent::new(32, win, atom, [gravity_and_flags, x as u32, y as u32, w, h]);
    conn.send_event(false, root, EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY, event).ok()?;
    conn.flush().ok()?;
    Some(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_from_client_adds_the_decoration_margins() {
        let ext = FrameExtents { left: 1, right: 2, top: 30, bottom: 3 };
        let r = frame_from_client(100.0, 130.0, 800.0, 600.0, ext);
        assert_eq!(r, Rect { x: 99.0, y: 100.0, w: 803.0, h: 633.0 });
    }

    #[test]
    fn client_from_frame_is_the_inverse_of_frame_from_client() {
        let ext = FrameExtents { left: 1, right: 2, top: 30, bottom: 3 };
        let frame = Rect { x: 50.0, y: 50.0, w: 900.0, h: 700.0 };
        let (cx, cy, cw, ch) = client_from_frame(frame, ext);
        let round_trip = frame_from_client(cx, cy, cw, ch, ext);
        assert_eq!(round_trip, frame);
    }

    #[test]
    fn client_from_frame_never_goes_below_one_pixel() {
        let ext = FrameExtents { left: 500, right: 500, top: 500, bottom: 500 };
        let (_, _, w, h) = client_from_frame(Rect { x: 0.0, y: 0.0, w: 10.0, h: 10.0 }, ext);
        assert!(w >= 1.0 && h >= 1.0);
    }

    #[test]
    fn workarea_indexes_by_current_desktop() {
        // Two desktops' worth of (x, y, w, h) concatenated, as XFCE
        // publishes it (verified live) — not a single global rect.
        let values = vec![0, 0, 1920, 1080, 0, 27, 1920, 1053];
        assert_eq!(workarea_rect_for_desktop(&values, 0), Some(Rect { x: 0.0, y: 0.0, w: 1920.0, h: 1080.0 }));
        assert_eq!(workarea_rect_for_desktop(&values, 1), Some(Rect { x: 0.0, y: 27.0, w: 1920.0, h: 1053.0 }));
        assert_eq!(workarea_rect_for_desktop(&values, 2), None);
    }

    #[test]
    fn point_in_rect_is_half_open() {
        let r = Rect { x: 0.0, y: 0.0, w: 100.0, h: 100.0 };
        assert!(point_in_rect(0.0, 0.0, r));
        assert!(point_in_rect(99.9, 99.9, r));
        assert!(!point_in_rect(100.0, 100.0, r));
        assert!(!point_in_rect(-0.1, 0.0, r));
    }

    #[test]
    fn intersect_clips_to_the_overlapping_region() {
        let a = Rect { x: 0.0, y: 0.0, w: 1920.0, h: 1080.0 };
        let b = Rect { x: 100.0, y: 100.0, w: 1920.0, h: 1080.0 };
        let r = intersect(a, b);
        assert_eq!(r, Rect { x: 100.0, y: 100.0, w: 1820.0, h: 980.0 });
    }

    #[test]
    fn intersect_of_disjoint_rects_is_zero_size() {
        let a = Rect { x: 0.0, y: 0.0, w: 100.0, h: 100.0 };
        let b = Rect { x: 500.0, y: 500.0, w: 100.0, h: 100.0 };
        let r = intersect(a, b);
        assert_eq!(r.w, 0.0);
        assert_eq!(r.h, 0.0);
    }
}
