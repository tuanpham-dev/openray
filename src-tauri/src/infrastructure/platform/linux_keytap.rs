//! A global keyboard listener for snippet auto-expansion on Linux/X11.
//!
//! Uses the XRecord extension to tap key presses system-wide — the same
//! mechanism `rdev` used on Linux, hand-rolled here on `x11rb` (already a
//! dependency) so the `rdev` crate can be dropped. Per the XRecord model it
//! opens two connections: one to create/control the record context, and one
//! that blocks streaming recorded protocol data. Runs on a dedicated thread
//! for the app's lifetime.
//!
//! Wayland is handled a layer up (`AutoExpander::available()` is false there);
//! this is only reached in an X11 session.

use x11rb::connection::{Connection, RequestConnection};
use x11rb::protocol::record::{self, ConnectionExt as _};
use x11rb::protocol::xproto::{self, ConnectionExt as _, Keysym};
use x11rb::x11_utils::TryParse;

/// One decoded key press handed to the auto-expander's matcher.
pub struct LinuxKeyEvent {
    /// The unshifted keysym of the key, for classifying special keys.
    pub keysym: u32,
    /// The character produced (honoring Shift), if the key is printable.
    pub text: Option<char>,
    pub control: bool,
    pub alt: bool,
}

type Handler = Box<dyn Fn(LinuxKeyEvent) + Send>;

// X11 modifier mask bits (xproto `KeyButMask`).
const SHIFT_MASK: u16 = 1 << 0;
const CONTROL_MASK: u16 = 1 << 2;
const MOD1_MASK: u16 = 1 << 3; // Alt

// XRecord reply categories (not yet named constants in x11rb's generated API).
const RECORD_FROM_SERVER: u8 = 0;

/// Installs the XRecord key tap on a dedicated thread. Setup happens on that
/// thread (the enable-context call blocks), so failures — no X server, no
/// XRecord extension — are logged there rather than returned. The tap simply
/// never delivers in that case, matching the honesty contract elsewhere.
pub fn start(handler: Handler) -> Result<(), String> {
    std::thread::spawn(move || {
        if let Err(e) = run(handler) {
            log::warn!("auto-expand: X11 keystroke listener stopped: {e}");
        }
    });
    Ok(())
}

fn run(handler: Handler) -> Result<(), Box<dyn std::error::Error>> {
    // "Two connections: one for record control, the other for reading data."
    let (ctrl_conn, _) = x11rb::connect(None)?;
    let (data_conn, _) = x11rb::connect(None)?;

    if ctrl_conn.extension_information(record::X11_EXTENSION_NAME)?.is_none() {
        return Err("XRecord extension is not available on this X server".into());
    }
    ctrl_conn
        .record_query_version(record::X11_XML_VERSION.0 as _, record::X11_XML_VERSION.1 as _)?
        .reply()?;

    // The keycode → keysym table, read once so key presses can be decoded.
    let setup = ctrl_conn.setup();
    let min_keycode = setup.min_keycode;
    let count = setup.max_keycode - setup.min_keycode + 1;
    let mapping = ctrl_conn.get_keyboard_mapping(min_keycode, count)?.reply()?;
    let per = mapping.keysyms_per_keycode as usize;
    let keysyms = mapping.keysyms;

    // Record core key-press events from every client.
    let rc = ctrl_conn.generate_id()?;
    let empty = record::Range8 { first: 0, last: 0 };
    let empty_ext = record::ExtRange { major: empty, minor: record::Range16 { first: 0, last: 0 } };
    let range = record::Range {
        core_requests: empty,
        core_replies: empty,
        ext_requests: empty_ext,
        ext_replies: empty_ext,
        delivered_events: empty,
        device_events: record::Range8 { first: xproto::KEY_PRESS_EVENT, last: xproto::KEY_PRESS_EVENT },
        errors: empty,
        client_started: false,
        client_died: false,
    };
    ctrl_conn.record_create_context(rc, 0, &[record::CS::ALL_CLIENTS.into()], &[range])?.check()?;

    log::info!("auto-expand: X11 XRecord key tap installed");

    for reply in data_conn.record_enable_context(rc)? {
        let reply = reply?;
        if reply.category != RECORD_FROM_SERVER || reply.client_swapped {
            continue;
        }
        let mut remaining = &reply.data[..];
        while !remaining.is_empty() {
            let before = remaining.len();
            if remaining[0] == xproto::KEY_PRESS_EVENT {
                if let Ok((event, rest)) = xproto::KeyPressEvent::try_parse(remaining) {
                    dispatch_key(&handler, event, &keysyms, per, min_keycode);
                    remaining = rest;
                } else {
                    break;
                }
            } else {
                // Some other event/record; skip one xEvent (32 bytes) to resync.
                remaining = &remaining[32.min(remaining.len())..];
            }
            if remaining.len() == before {
                break;
            }
        }
    }
    Ok(())
}

fn dispatch_key(handler: &Handler, event: xproto::KeyPressEvent, keysyms: &[Keysym], per: usize, min_keycode: u8) {
    let keycode = event.detail;
    if keycode < min_keycode || per == 0 {
        return;
    }
    let base = (keycode - min_keycode) as usize * per;
    let unshifted = keysyms.get(base).copied().unwrap_or(0);
    let shifted = keysyms.get(base + 1).copied().unwrap_or(unshifted);

    let state = event.state.bits();
    let is_shift = state & SHIFT_MASK != 0;
    let sym = if is_shift { shifted } else { unshifted };

    handler(LinuxKeyEvent {
        keysym: unshifted,
        text: keysym_to_char(sym),
        control: state & CONTROL_MASK != 0,
        alt: state & MOD1_MASK != 0,
    });
}

/// Maps an X11 keysym to a character for the matcher. Covers Latin-1 (whose
/// keysyms are their Unicode code points) and the `U+xxxx` Unicode keysym
/// range; anything else (function keys, etc.) is left to keysym classification.
fn keysym_to_char(sym: u32) -> Option<char> {
    match sym {
        0x20..=0x7e | 0xa0..=0xff => char::from_u32(sym).filter(|c| !c.is_control()),
        // Unicode keysyms: 0x01000000 | code point.
        0x0100_0100..=0x0110_ffff => char::from_u32(sym - 0x0100_0000).filter(|c| !c.is_control()),
        _ => None,
    }
}
