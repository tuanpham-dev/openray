//! Remembers which window had input focus before the palette appeared, so
//! it can be focused again when the palette hides.
//!
//! X11 does not hand focus back on its own. Unmapping a window leaves the
//! input focus pointing at it (verified: with the palette hidden,
//! `GetInputFocus` still names the palette), which means any synthetic
//! keystroke sent afterwards — the Ctrl+V that snippet and clipboard
//! pasting depend on — is delivered to a window the user can't see instead
//! of the app they were working in.
//!
//! Everything here is best-effort: the previously focused window may have
//! closed in the meantime, and failing to restore focus should never
//! surface as an error to the user.

use std::sync::Mutex;

use x11rb::connection::Connection;
use x11rb::protocol::xproto::{AtomEnum, ConnectionExt, InputFocus};

/// The window that had focus when the palette was last shown.
static PREVIOUS_FOCUS: Mutex<Option<u32>> = Mutex::new(None);

/// The palette's X window id, resolved lazily and cached — GTK keeps the
/// same X window across hide/show cycles.
static PALETTE_XID: Mutex<Option<u32>> = Mutex::new(None);

/// Records the currently focused window. Call immediately *before* showing
/// the palette, while the user's own window still holds focus.
pub fn remember_focused_window() {
    let Some(window) = focused_window() else { return };
    *PREVIOUS_FOCUS.lock().unwrap() = Some(window);
}

/// Reads the window captured by `remember_focused_window` without
/// consuming it — used by Navigation's menu-bar reader, which needs to
/// know which app was focused before the palette opened but must leave
/// the value in place for the palette's own hide-time focus restore.
pub fn previously_focused_window() -> Option<u32> {
    *PREVIOUS_FOCUS.lock().unwrap()
}

/// The window currently holding X input focus, right now — as opposed to
/// `previously_focused_window`'s snapshot from before the palette last
/// appeared. Used by Window Management to target the right window whether
/// invoked from an open palette (focus is ours; fall back to the previous
/// snapshot) or from a hotkey with the palette never shown (focus is
/// already the real target).
pub fn current_focus() -> Option<u32> {
    focused_window()
}

/// Walks up from `win` to the nearest ancestor that has `WM_CLASS` set —
/// the actual top-level client window, as opposed to a focus-proxy child.
/// X input focus is very often a hidden 1x1 GTK/Qt focus-proxy child
/// window rather than the application's real top-level (verified directly
/// on this machine: Thunar's focus target has no `WM_CLASS` at all, its
/// parent does) — every property-reading caller needs the resolved
/// top-level, not the raw focus target. Bounded to a handful of hops;
/// window trees are shallow in practice, and giving up and returning the
/// original id is a safe fallback.
pub fn resolve_toplevel(win: u32) -> u32 {
    resolve_toplevel_inner(win).unwrap_or(win)
}

fn resolve_toplevel_inner(win: u32) -> Option<u32> {
    let (conn, screen_num) = x11rb::connect(None).ok()?;
    let root = conn.setup().roots.get(screen_num)?.root;

    let mut current = win;
    for _ in 0..10 {
        if has_wm_class(&conn, current) {
            return Some(current);
        }
        let parent = conn.query_tree(current).ok()?.reply().ok()?.parent;
        if parent == root || parent == 0 {
            return Some(current);
        }
        current = parent;
    }
    Some(current)
}

fn has_wm_class(conn: &impl Connection, win: u32) -> bool {
    conn.get_property(false, win, AtomEnum::WM_CLASS, AtomEnum::STRING, 0, 1)
        .ok()
        .and_then(|c| c.reply().ok())
        .map(|r| !r.value.is_empty())
        .unwrap_or(false)
}

/// Whether `win` belongs to this process — used by Window Management to
/// tell "the palette (or another of our own windows) currently holds
/// focus" apart from "a real target app holds focus".
pub fn is_own_window(win: u32) -> bool {
    pid_of_window(win) == Some(std::process::id())
}

/// The owning process id of `win`, via `_NET_WM_PID` — used by
/// `getFrontmostApplication` to resolve the focused window all the way to
/// an application identity. Resolve `win` through `resolve_toplevel` first
/// if it might be a focus-proxy child (see that function's doc comment);
/// this reads whatever window id it's given as-is.
pub fn pid_of_window(win: u32) -> Option<u32> {
    let (conn, _) = x11rb::connect(None).ok()?;
    let pid_atom = conn.intern_atom(false, b"_NET_WM_PID").ok()?.reply().ok()?.atom;
    let pid = conn
        .get_property(false, win, pid_atom, AtomEnum::CARDINAL, 0, 1)
        .ok()?
        .reply()
        .ok()?
        .value32()?
        .next();
    pid
}

/// Returns focus to the window captured by `remember_focused_window`.
pub fn restore_focus() {
    let Some(window) = PREVIOUS_FOCUS.lock().unwrap().take() else { return };

    // `PointerRoot`/`None` are sentinel values, not real windows; focusing
    // them would be a no-op at best.
    if window == x11rb::NONE || window == u32::from(InputFocus::POINTER_ROOT) {
        return;
    }

    let Ok((conn, _)) = x11rb::connect(None) else { return };
    // Errors here are expected when the window has closed since capture.
    if conn.set_input_focus(InputFocus::PARENT, window, x11rb::CURRENT_TIME).is_ok() {
        // `flush()` alone only guarantees the request left our socket
        // buffer, not that the server has *processed* it yet — X gives no
        // cross-connection ordering guarantee, so a caller that opens a
        // *fresh* connection right after this (Window Management's
        // `target()`, on every command) can race ahead of the server and
        // read the pre-restore focus back. A follow-up round-trip on this
        // *same* connection forces the wait: the server processes a
        // connection's own requests strictly in order, so once this reply
        // arrives, the `set_input_focus` above is guaranteed applied.
        // Found live: intermittent "no focused window to manage" reports
        // that got rarer but didn't disappear after adding a WM-tracked
        // fallback — the fallback was papering over this race, not fixing
        // it, since `_NET_ACTIVE_WINDOW` can lag the same way.
        let _ = conn.flush();
        if let Ok(cookie) = conn.get_input_focus() {
            let _ = cookie.reply();
        }
    }
}

fn focused_window() -> Option<u32> {
    let (conn, _) = x11rb::connect(None).ok()?;
    let focus = conn.get_input_focus().ok()?.reply().ok()?.focus;
    (focus != x11rb::NONE && focus != u32::from(InputFocus::POINTER_ROOT)).then_some(focus)
}

/// Whether the X input focus still belongs to this process.
///
/// Activating a passive key grab — the transient Escape grab bound while
/// the palette is visible, or the palette toggle hotkey — makes the server
/// send the focused window a FocusOut with mode=Grab, which GTK surfaces
/// as an ordinary focus-out even though the real input focus never moved.
/// The hide-on-focus-loss handler uses this to tell that apart from a
/// genuine click into another app: if the server still names one of our
/// windows as the focus, the "loss" is only the grab's side effect and
/// the palette must stay up.
///
/// Also resolves to the top-level before reading `_NET_WM_PID`, per
/// `resolve_toplevel`'s doc comment: X input focus is often a hidden
/// focus-proxy child lacking the properties its top-level carries.
/// **Disclosed gap:** this is reasoned from that doc comment, not
/// confirmed against the failure it targets — a real WM (GNOME/KDE/XFCE)
/// may hand a `<select>` popup's real focus-proxy child actual X focus in
/// a way this environment doesn't reproduce. Verified only that, in a
/// bare Xvfb session with no window manager, opening AI Chat's model
/// dropdown never moves real X focus off the palette's own already-PID-
/// tagged top-level in the first place — so this fix is untested against
/// its own target case; the WM-less environment can't exercise it.
pub fn input_focus_is_ours() -> bool {
    let Ok((conn, _)) = x11rb::connect(None) else { return false };
    let Ok(cookie) = conn.get_input_focus() else { return false };
    let Ok(reply) = cookie.reply() else { return false };
    let focus = reply.focus;
    if focus == x11rb::NONE || focus == u32::from(InputFocus::POINTER_ROOT) {
        return false;
    }
    let focus = resolve_toplevel(focus);

    let Ok(pid_atom) = conn.intern_atom(false, b"_NET_WM_PID") else { return false };
    let Ok(pid_atom) = pid_atom.reply() else { return false };
    let pid = conn
        .get_property(false, focus, pid_atom.atom, AtomEnum::CARDINAL, 0, 1)
        .ok()
        .and_then(|c| c.reply().ok())
        .and_then(|r| r.value32().and_then(|mut v| v.next()));
    pid == Some(std::process::id())
}

/// Unmaps the palette directly at the X server.
///
/// `WebviewWindow::hide()` marshals through tao's event loop, and that
/// hand-off can stall: GTK's state flips to hidden immediately while the
/// actual UnmapWindow request doesn't reach the server until the next
/// input event wakes the loop — observed as the palette staying on screen
/// for seconds after Escape, "closing" only on the next keypress (and,
/// symmetrically, a hotkey show consuming the first keystroke as its
/// wake-up). Talking to the server on our own connection sidesteps the
/// loop entirely; GTK already considers the window hidden, so the states
/// agree.
pub fn force_unmap_palette() {
    let Ok((conn, screen)) = x11rb::connect(None) else { return };

    let cached = *PALETTE_XID.lock().unwrap();
    let xid = match cached.filter(|&xid| is_our_palette(&conn, xid).unwrap_or(false)) {
        Some(xid) => Some(xid),
        None => {
            let found = find_palette_window(&conn, screen);
            *PALETTE_XID.lock().unwrap() = found;
            found
        }
    };

    if let Some(xid) = xid {
        let _ = conn.unmap_window(xid);
        let _ = conn.flush();
        // Same cross-connection ordering gap as `restore_focus` — the very
        // next thing `hide_palette` does is call that function on its own
        // fresh connection, and without this round-trip there's no
        // guarantee the server has processed the unmap first.
        if let Ok(cookie) = conn.get_input_focus() {
            let _ = cookie.reply();
        }
    }
}

/// Gives the palette input focus directly at the X server.
///
/// The marshalled `set_focus` rides the same sometimes-starved event loop
/// as everything else, and XFWM's focus-stealing prevention won't focus a
/// re-mapped window on its own — so after a re-show, keys could land in
/// the previously focused app until something else woke the loop (the
/// user's "first Escape does nothing"). Setting focus on our own
/// connection is immediate, and the resulting FocusIn event doubles as
/// the wake-up for anything the loop still has queued.
pub fn focus_palette() {
    let Ok((conn, screen)) = x11rb::connect(None) else { return };

    let cached = *PALETTE_XID.lock().unwrap();
    let xid = match cached.filter(|&xid| is_our_palette(&conn, xid).unwrap_or(false)) {
        Some(xid) => Some(xid),
        None => {
            let found = find_palette_window(&conn, screen);
            *PALETTE_XID.lock().unwrap() = found;
            found
        }
    };

    if let Some(xid) = xid {
        let _ = conn.set_input_focus(InputFocus::PARENT, xid, x11rb::CURRENT_TIME);
        let _ = conn.flush();
    }
}

/// Whether `xid` is this process's palette window: right PID, right title.
fn is_our_palette(conn: &impl Connection, xid: u32) -> Option<bool> {
    let pid_atom = conn.intern_atom(false, b"_NET_WM_PID").ok()?.reply().ok()?.atom;
    let pid = conn
        .get_property(false, xid, pid_atom, AtomEnum::CARDINAL, 0, 1)
        .ok()?
        .reply()
        .ok()?
        .value32()?
        .next()?;
    if pid != std::process::id() {
        return Some(false);
    }

    let name = conn
        .get_property(false, xid, AtomEnum::WM_NAME, AtomEnum::STRING, 0, 64)
        .ok()?
        .reply()
        .ok()?;
    Some(name.value == b"OpenRay")
}

fn find_palette_window(conn: &impl Connection, screen: usize) -> Option<u32> {
    let root = conn.setup().roots.get(screen)?.root;
    let tree = conn.query_tree(root).ok()?.reply().ok()?;
    tree.children.into_iter().find(|&child| {
        // The WM reparents clients into frames, so check one level of
        // children too.
        if is_our_palette(conn, child).unwrap_or(false) {
            return true;
        }
        false
    }).or_else(|| {
        let tree = conn.query_tree(root).ok()?.reply().ok()?;
        for frame in tree.children {
            if let Ok(Ok(inner)) = conn.query_tree(frame).map(|c| c.reply()) {
                for child in inner.children {
                    if is_our_palette(conn, child).unwrap_or(false) {
                        return Some(child);
                    }
                }
            }
        }
        None
    })
}
