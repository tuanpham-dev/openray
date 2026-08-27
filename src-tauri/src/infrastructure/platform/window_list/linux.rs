//! EWMH-based window enumeration/activation/close (X11 only — there is no
//! portal-level "list all windows" API on Wayland, so this reports
//! unavailable there the same way `hotkey`'s Escape grab does).

use std::io::Cursor;

use base64::Engine;
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{Atom, AtomEnum, ClientMessageEvent, ConnectionExt, EventMask};

use super::NativeWindow;

pub fn available() -> bool {
    x11rb::connect(None).is_ok()
}

pub fn list() -> Vec<NativeWindow> {
    list_inner().unwrap_or_default()
}

fn list_inner() -> Option<Vec<NativeWindow>> {
    let (conn, screen_num) = x11rb::connect(None).ok()?;
    let root = conn.setup().roots.get(screen_num)?.root;

    let client_list_atom = intern(&conn, b"_NET_CLIENT_LIST_STACKING")?;
    let net_wm_state_atom = intern(&conn, b"_NET_WM_STATE")?;
    let skip_taskbar_atom = intern(&conn, b"_NET_WM_STATE_SKIP_TASKBAR")?;
    let window_type_atom = intern(&conn, b"_NET_WM_WINDOW_TYPE")?;
    let type_normal_atom = intern(&conn, b"_NET_WM_WINDOW_TYPE_NORMAL")?;
    let type_dialog_atom = intern(&conn, b"_NET_WM_WINDOW_TYPE_DIALOG")?;
    let net_wm_name_atom = intern(&conn, b"_NET_WM_NAME")?;
    let net_wm_icon_atom = intern(&conn, b"_NET_WM_ICON")?;
    let utf8_atom = intern(&conn, b"UTF8_STRING")?;
    let pid_atom = intern(&conn, b"_NET_WM_PID")?;

    let stacking: Vec<u32> = conn
        .get_property(false, root, client_list_atom, AtomEnum::WINDOW, 0, 1024)
        .ok()?
        .reply()
        .ok()?
        .value32()?
        .collect();

    let own_pid = std::process::id();
    let mut result = Vec::new();

    // Reverse: `_NET_CLIENT_LIST_STACKING` is bottom-to-top, so the last
    // entry is the topmost/most-recently-raised window — the closest
    // proxy to "most recently used" a single property query can give us.
    for &win in stacking.iter().rev() {
        if window_pid(&conn, win, pid_atom) == Some(own_pid) {
            continue;
        }

        let skip_taskbar = atom_list(&conn, win, net_wm_state_atom).contains(&skip_taskbar_atom);
        let window_types = atom_list(&conn, win, window_type_atom);
        let title = window_title(&conn, win, net_wm_name_atom, utf8_atom);

        if !should_include_window(title.is_some(), skip_taskbar, &window_types, type_normal_atom, type_dialog_atom) {
            continue;
        }

        let class = wm_class(&conn, win);
        let icon = window_icon_data_uri(&conn, win, net_wm_icon_atom);

        result.push(NativeWindow {
            id: win.to_string(),
            title: title.unwrap_or_default(),
            app_name: class.clone().unwrap_or_default(),
            app_match_hint: class.unwrap_or_default().to_lowercase(),
            icon,
        });
    }

    Some(result)
}

/// Pure filter predicate, kept separate from the X11 round-trips above so
/// it's unit-testable without a live connection.
fn should_include_window(has_title: bool, skip_taskbar: bool, window_types: &[Atom], normal_atom: Atom, dialog_atom: Atom) -> bool {
    if !has_title || skip_taskbar {
        return false;
    }
    // EWMH: absence of _NET_WM_WINDOW_TYPE implies NORMAL for a top-level,
    // non-override-redirect window — most legacy apps never set it.
    window_types.is_empty() || window_types.iter().any(|&t| t == normal_atom || t == dialog_atom)
}

pub fn activate(id: &str) -> bool {
    activate_inner(id).is_some()
}

fn activate_inner(id: &str) -> Option<()> {
    let win: u32 = id.parse().ok()?;
    let (conn, screen_num) = x11rb::connect(None).ok()?;
    let root = conn.setup().roots.get(screen_num)?.root;
    let atom = intern(&conn, b"_NET_ACTIVE_WINDOW")?;

    // source indication 2 = "pager/other tool", the same class of request
    // Switch Windows commands make; timestamp 0 means "don't know".
    let event = ClientMessageEvent::new(32, win, atom, [2u32, 0, 0, 0, 0]);
    conn.send_event(false, root, EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY, event).ok()?;
    conn.flush().ok()?;
    Some(())
}

pub fn close(id: &str) -> bool {
    close_inner(id).is_some()
}

fn close_inner(id: &str) -> Option<()> {
    let win: u32 = id.parse().ok()?;
    let (conn, screen_num) = x11rb::connect(None).ok()?;
    let root = conn.setup().roots.get(screen_num)?.root;
    let atom = intern(&conn, b"_NET_CLOSE_WINDOW")?;

    let event = ClientMessageEvent::new(32, win, atom, [0u32, 2, 0, 0, 0]);
    conn.send_event(false, root, EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY, event).ok()?;
    conn.flush().ok()?;
    Some(())
}

fn intern(conn: &impl Connection, name: &[u8]) -> Option<Atom> {
    conn.intern_atom(false, name).ok()?.reply().ok().map(|r| r.atom)
}

fn window_pid(conn: &impl Connection, win: u32, pid_atom: Atom) -> Option<u32> {
    conn.get_property(false, win, pid_atom, AtomEnum::CARDINAL, 0, 1).ok()?.reply().ok()?.value32()?.next()
}

fn atom_list(conn: &impl Connection, win: u32, prop_atom: Atom) -> Vec<Atom> {
    conn.get_property(false, win, prop_atom, AtomEnum::ATOM, 0, 32)
        .ok()
        .and_then(|c| c.reply().ok())
        .and_then(|r| r.value32().map(|v| v.collect()))
        .unwrap_or_default()
}

fn window_title(conn: &impl Connection, win: u32, net_wm_name: Atom, utf8: Atom) -> Option<String> {
    if let Some(bytes) = property_bytes(conn, win, net_wm_name, utf8) {
        if let Ok(s) = String::from_utf8(bytes) {
            let s = s.trim().to_string();
            if !s.is_empty() {
                return Some(s);
            }
        }
    }

    let bytes = property_bytes(conn, win, AtomEnum::WM_NAME.into(), AtomEnum::STRING.into())?;
    let s = String::from_utf8_lossy(&bytes).trim().to_string();
    (!s.is_empty()).then_some(s)
}

fn property_bytes(conn: &impl Connection, win: u32, prop: Atom, type_: Atom) -> Option<Vec<u8>> {
    conn.get_property(false, win, prop, type_, 0, 1024).ok()?.reply().ok().map(|r| r.value)
}

fn wm_class(conn: &impl Connection, win: u32) -> Option<String> {
    let bytes = property_bytes(conn, win, AtomEnum::WM_CLASS.into(), AtomEnum::STRING.into())?;
    let mut parts = bytes.split(|&b| b == 0).filter(|s| !s.is_empty());
    let instance = parts.next()?;
    let class = parts.next().unwrap_or(instance);
    Some(String::from_utf8_lossy(class).to_string())
}

/// The largest icon in `_NET_WM_ICON` (a concatenation of `width, height,
/// ARGB pixels...` blocks at whatever sizes the app provided), re-encoded
/// as a PNG data URI.
fn window_icon_data_uri(conn: &impl Connection, win: u32, icon_atom: Atom) -> Option<String> {
    let data: Vec<u32> = conn
        .get_property(false, win, icon_atom, AtomEnum::CARDINAL, 0, 200_000)
        .ok()?
        .reply()
        .ok()?
        .value32()?
        .collect();

    let mut offset = 0usize;
    let mut best: Option<(u32, u32, &[u32])> = None;
    while offset + 2 <= data.len() {
        let (w, h) = (data[offset], data[offset + 1]);
        let count = w as usize * h as usize;
        if count == 0 || offset + 2 + count > data.len() {
            break;
        }
        let pixels = &data[offset + 2..offset + 2 + count];
        // Not `Option::is_none_or` — stable since Rust 1.82, this crate's
        // MSRV is 1.77.2 (clippy::incompatible_msrv).
        if best.map_or(true, |(bw, bh, _)| w * h > bw * bh) {
            best = Some((w, h, pixels));
        }
        offset += 2 + count;
    }

    let (w, h, pixels) = best?;
    let mut rgba = Vec::with_capacity(pixels.len() * 4);
    for &argb in pixels {
        rgba.extend_from_slice(&[(argb >> 16) as u8, (argb >> 8) as u8, argb as u8, (argb >> 24) as u8]);
    }

    let buffer: image::RgbaImage = image::ImageBuffer::from_raw(w, h, rgba)?;
    let mut bytes = Vec::new();
    buffer.write_to(&mut Cursor::new(&mut bytes), image::ImageFormat::Png).ok()?;
    Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    const NORMAL: Atom = 1;
    const DIALOG: Atom = 2;
    const OTHER: Atom = 3;

    #[test]
    fn excludes_windows_without_a_title() {
        assert!(!should_include_window(false, false, &[], NORMAL, DIALOG));
    }

    #[test]
    fn excludes_skip_taskbar_windows() {
        assert!(!should_include_window(true, true, &[NORMAL], NORMAL, DIALOG));
    }

    #[test]
    fn includes_windows_with_no_declared_type() {
        assert!(should_include_window(true, false, &[], NORMAL, DIALOG));
    }

    #[test]
    fn includes_normal_and_dialog_types() {
        assert!(should_include_window(true, false, &[NORMAL], NORMAL, DIALOG));
        assert!(should_include_window(true, false, &[DIALOG], NORMAL, DIALOG));
    }

    #[test]
    fn excludes_other_declared_types() {
        assert!(!should_include_window(true, false, &[OTHER], NORMAL, DIALOG));
    }
}
