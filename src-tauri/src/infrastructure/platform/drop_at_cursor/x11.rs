//! Synthesized XDND drag source. One-shot, not a resident server like
//! `clipboard_multi/x11.rs`'s clipboard offer: a drop is a bounded
//! interaction (connect, run the handshake to completion or a deadline,
//! disconnect) rather than something that needs to keep serving after
//! the call returns, and every `XdndEnter`/`Position`/`Drop` message
//! carries this connection's source window id, so there's nothing to
//! hand off to a background thread.
//!
//! Runs synchronously on the calling thread. Both call paths that reach
//! this — the grid action's Tauri IPC handler, and the hotkey `dispatch`
//! spawn (see `infrastructure::hotkey::dispatch`'s doc comment) — are
//! already off the main thread, and the internal loop never makes an
//! unbounded blocking call (`poll_for_event` plus a sleep under a hard
//! deadline, same discipline as the clipboard server), so this can't
//! wedge the app the way a `wait_for_event` loop could.
//!
//! Event ordering assumption to preserve: do NOT assume `XdndStatus`
//! arrives before the target's `SelectionRequest` for the data, or that
//! `XdndStatus`'s accept bit means anything. Chrome, spike-tested,
//! requested the selection *before* sending any status, and reported
//! `accept=false` on both `XdndStatus` and `XdndFinished` while still
//! delivering the file to its `drop` handler — see this module's parent
//! doc comment.

use std::path::Path;
use std::time::{Duration, Instant};

use x11rb::connection::Connection;
use x11rb::protocol::xproto::{
    AtomEnum, ClientMessageEvent, ConnectionExt, CreateWindowAux, EventMask, PropMode,
    SelectionNotifyEvent, Time, Window, WindowClass, SELECTION_NOTIFY_EVENT,
};
use x11rb::protocol::Event;
use x11rb::rust_connection::RustConnection;
use x11rb::wrapper::ConnectionExt as _;
use x11rb::{COPY_DEPTH_FROM_PARENT, COPY_FROM_PARENT};

x11rb::atom_manager! {
    Atoms: AtomCookies {
        XdndAware,
        XdndEnter,
        XdndPosition,
        XdndStatus,
        XdndDrop,
        XdndFinished,
        XdndSelection,
        XdndActionCopy,
    }
}

const XDND_VERSION: u32 = 5;
const POLL_INTERVAL: Duration = Duration::from_millis(10);
const DEADLINE: Duration = Duration::from_secs(3);
/// How long to wait for an `XdndStatus` reply before sending `XdndDrop`
/// anyway — Chrome (spike-verified) can skip straight to requesting the
/// selection without ever sending a status first.
const STATUS_GRACE: Duration = Duration::from_millis(300);

pub fn drop_file_at_cursor(path: &Path) -> Result<(), String> {
    let (conn, screen_num) = RustConnection::connect(None).map_err(|e| e.to_string())?;
    let screen = &conn.setup().roots[screen_num];
    let root = screen.root;

    let source = conn.generate_id().map_err(|e| e.to_string())?;
    conn.create_window(
        COPY_DEPTH_FROM_PARENT,
        source,
        root,
        0,
        0,
        1,
        1,
        0,
        WindowClass::COPY_FROM_PARENT,
        COPY_FROM_PARENT,
        &CreateWindowAux::new(),
    )
    .map_err(|e| e.to_string())?;

    let atoms = Atoms::new(&conn).map_err(|e| e.to_string())?.reply().map_err(|e| e.to_string())?;
    let uri_list_atom =
        conn.intern_atom(false, b"text/uri-list").map_err(|e| e.to_string())?.reply().map_err(|e| e.to_string())?.atom;

    conn.change_property32(PropMode::REPLACE, source, atoms.XdndAware, AtomEnum::ATOM, &[XDND_VERSION])
        .map_err(|e| e.to_string())?;
    conn.flush().map_err(|e| e.to_string())?;

    let (target, root_x, root_y, target_version) = find_target(&conn, root, &atoms)?;
    let version = XDND_VERSION.min(target_version);

    conn.set_selection_owner(source, atoms.XdndSelection, Time::CURRENT_TIME).map_err(|e| e.to_string())?;
    conn.flush().map_err(|e| e.to_string())?;
    let owner =
        conn.get_selection_owner(atoms.XdndSelection).map_err(|e| e.to_string())?.reply().map_err(|e| e.to_string())?;
    if owner.owner != source {
        return Err("failed to claim XdndSelection".to_string());
    }

    let payload = super::uri_list_payload(path);

    let send = |event: ClientMessageEvent| -> Result<(), String> {
        conn.send_event(false, target, EventMask::NO_EVENT, event).map_err(|e| e.to_string())?;
        conn.flush().map_err(|e| e.to_string())
    };

    send(ClientMessageEvent::new(32, target, atoms.XdndEnter, super::enter_data(source, version, uri_list_atom)))?;
    send(ClientMessageEvent::new(
        32,
        target,
        atoms.XdndPosition,
        super::position_data(source, root_x, root_y, atoms.XdndActionCopy),
    ))?;

    let start = Instant::now();
    let deadline = start + DEADLINE;
    let mut drop_sent = false;
    let mut got_status = false;
    let mut served = false;
    let mut finished = false;

    while Instant::now() < deadline && !finished {
        while let Some(event) = conn.poll_for_event().map_err(|e| e.to_string())? {
            match event {
                Event::SelectionRequest(req) if req.selection == atoms.XdndSelection => {
                    conn.change_property8(PropMode::REPLACE, req.requestor, req.property, req.target, &payload)
                        .map_err(|e| e.to_string())?;
                    conn.flush().map_err(|e| e.to_string())?;
                    let notify = SelectionNotifyEvent {
                        response_type: SELECTION_NOTIFY_EVENT,
                        sequence: 0,
                        time: req.time,
                        requestor: req.requestor,
                        selection: req.selection,
                        target: req.target,
                        property: req.property,
                    };
                    conn.send_event(false, req.requestor, EventMask::NO_EVENT, notify).map_err(|e| e.to_string())?;
                    conn.flush().map_err(|e| e.to_string())?;
                    served = true;
                }
                Event::ClientMessage(cm) if cm.type_ == atoms.XdndStatus => {
                    got_status = true;
                }
                Event::ClientMessage(cm) if cm.type_ == atoms.XdndFinished => {
                    finished = true;
                }
                _ => {}
            }
        }

        if !drop_sent && (got_status || Instant::now() >= start + STATUS_GRACE) {
            send(ClientMessageEvent::new(32, target, atoms.XdndDrop, super::drop_data(source)))?;
            drop_sent = true;
        }

        if finished {
            break;
        }
        std::thread::sleep(POLL_INTERVAL);
    }

    if served || finished {
        Ok(())
    } else {
        Err("drop timed out".to_string())
    }
}

/// Walks from the root window down through whichever child sits under
/// the cursor at each level (`QueryPointer`'s own descent, the same
/// technique `xdotool getmouselocation` uses) until it finds a window
/// with `XdndAware` set — the window manager's reparenting frame sits
/// above the client's real top-level and never has this property, so the
/// walk must check every level on the way down, not just the outermost
/// or innermost window.
fn find_target(conn: &RustConnection, root: Window, atoms: &Atoms) -> Result<(Window, i16, i16, u32), String> {
    let root_reply = conn.query_pointer(root).map_err(|e| e.to_string())?.reply().map_err(|e| e.to_string())?;
    let (root_x, root_y) = (root_reply.root_x, root_reply.root_y);

    let mut current = root_reply.child;
    while current != 0 {
        if let Some(version) = xdnd_version(conn, current, atoms)? {
            return Ok((current, root_x, root_y, version));
        }
        current = conn.query_pointer(current).map_err(|e| e.to_string())?.reply().map_err(|e| e.to_string())?.child;
    }

    Err("no drop target under the cursor".to_string())
}

fn xdnd_version(conn: &RustConnection, window: Window, atoms: &Atoms) -> Result<Option<u32>, String> {
    let prop = conn
        .get_property(false, window, atoms.XdndAware, AtomEnum::ATOM, 0, 1)
        .map_err(|e| e.to_string())?
        .reply()
        .map_err(|e| e.to_string())?;
    Ok(prop.value32().and_then(|mut values| values.next()))
}
