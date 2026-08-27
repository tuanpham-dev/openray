//! Selection-owner server for "Auto" paste format on X11 — offers
//! multiple representations of one screenshot at once. Modeled directly
//! on arboard's own internal serving loop
//! (`arboard::platform::linux::x11::{serve_requests, handle_selection_request}`,
//! read line-by-line during planning), which supports exactly this
//! multi-format shape internally (`Inner::write` takes a `Vec` of typed
//! entries) but doesn't expose it publicly. Deliberately minimal: the
//! CLIPBOARD selection only (no PRIMARY/SECONDARY), serve-only (never
//! reads), no INCR chunked transfers (arboard's own server ships without
//! them too — one `ChangeProperty` per answer; x11rb negotiates
//! BIG-REQUESTS, giving on the order of megabytes per property write,
//! and `set_offer` rejects anything over that rather than hanging), and
//! no clipboard-manager exit handover (the offer is gone once OpenRay
//! quits, same as most non-persisting apps; clipboard *history* managers
//! already capture content the moment ownership changes).
//!
//! Threading is the deadlock-sensitive part of this file — see
//! `infrastructure::hotkey`'s `HOTKEY_PLUGIN_LOCK` doc comment for the
//! failure shape this deliberately avoids (a thread blocked waiting on
//! the main loop while the main loop is itself blocked waiting on that
//! same thread). The server's loop never makes an unbounded blocking
//! call — `poll_for_event` plus a *timed* channel receive, never
//! `wait_for_event` — so nothing can ever be stuck waiting on this
//! thread while it waits on something else. `set_offer` itself blocks
//! the caller for at most `CLAIM_TIMEOUT`, then reports failure so the
//! caller can fall back to arboard rather than hang a Tauri IPC thread.

use std::collections::HashMap;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::OnceLock;
use std::time::Duration;

use image::ImageEncoder;
use x11rb::connection::{Connection, RequestConnection};
use x11rb::protocol::xproto::{
    Atom, AtomEnum, ConnectionExt as _, CreateWindowAux, EventMask, PropMode,
    SelectionNotifyEvent, SelectionRequestEvent, Time, WindowClass, SELECTION_NOTIFY_EVENT,
};
use x11rb::protocol::Event;
use x11rb::rust_connection::RustConnection;
use x11rb::wrapper::ConnectionExt as _;
use x11rb::{COPY_DEPTH_FROM_PARENT, COPY_FROM_PARENT};

use super::{OfferEntry, Payload};

x11rb::atom_manager! {
    Atoms: AtomCookies {
        CLIPBOARD,
        TARGETS,
        ATOM,
    }
}

const POLL_INTERVAL: Duration = Duration::from_millis(50);
const CLAIM_TIMEOUT: Duration = Duration::from_secs(1);
/// Headroom under the connection's actual `maximum_request_bytes` for
/// the X11 request header itself — `set_offer` rejects any single entry
/// larger than that, and the caller falls back to arboard.
const REQUEST_HEADER_ALLOWANCE: usize = 1024;

struct Claim {
    entries: Vec<OfferEntry>,
    reply: Sender<Result<(), String>>,
}

static COMMANDS: OnceLock<Sender<Claim>> = OnceLock::new();

pub fn set_offer(entries: Vec<OfferEntry>) -> Result<(), String> {
    let commands = COMMANDS.get_or_init(spawn_server);
    let (reply_tx, reply_rx) = mpsc::channel();
    commands
        .send(Claim { entries, reply: reply_tx })
        .map_err(|_| "x11 clipboard server thread is gone".to_string())?;
    reply_rx
        .recv_timeout(CLAIM_TIMEOUT)
        .map_err(|_| "x11 clipboard server did not respond in time".to_string())?
}

fn spawn_server() -> Sender<Claim> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        if let Err(e) = run_server(rx) {
            log::error!("x11 clipboard server stopped: {e}");
        }
    });
    tx
}

/// The offer currently owned by us, plus everything needed to answer
/// requests for it without re-touching the filesystem or the X server
/// more than necessary.
struct ActiveOffer {
    entries: Vec<OfferEntry>,
    /// `entries[i]`'s interned target atom, same indexing.
    atom_by_entry: Vec<Atom>,
    /// Lazily-encoded entries, cached after the first request that asks
    /// for them — a burst of requests for the same target (several
    /// paste targets, or a clipboard history manager plus the real
    /// paste) only pays the decode/encode cost once.
    materialized: HashMap<usize, Vec<u8>>,
}

fn run_server(commands: Receiver<Claim>) -> Result<(), String> {
    let (conn, screen_num) = RustConnection::connect(None).map_err(|e| e.to_string())?;
    let screen = conn.setup().roots.get(screen_num).ok_or("no X11 screen found")?;
    let window = conn.generate_id().map_err(|e| e.to_string())?;
    conn.create_window(
        COPY_DEPTH_FROM_PARENT,
        window,
        screen.root,
        0,
        0,
        1,
        1,
        0,
        WindowClass::COPY_FROM_PARENT,
        COPY_FROM_PARENT,
        &CreateWindowAux::new().event_mask(EventMask::PROPERTY_CHANGE | EventMask::STRUCTURE_NOTIFY),
    )
    .map_err(|e| e.to_string())?;
    conn.flush().map_err(|e| e.to_string())?;

    let atoms = Atoms::new(&conn).map_err(|e| e.to_string())?.reply().map_err(|e| e.to_string())?;
    let max_entry_bytes = conn.maximum_request_bytes().saturating_sub(REQUEST_HEADER_ALLOWANCE);

    let mut current: Option<ActiveOffer> = None;

    loop {
        // Drain every pending claim before going back to polling for X
        // events — a rapid burst of copies should only pay for one X
        // round-trip for the newest one, not fall behind.
        loop {
            match commands.recv_timeout(POLL_INTERVAL) {
                Ok(claim) => {
                    let result = claim_selection(&conn, window, &atoms, claim.entries, max_entry_bytes);
                    match result {
                        Ok(offer) => {
                            current = Some(offer);
                            let _ = claim.reply.send(Ok(()));
                        }
                        Err(e) => {
                            let _ = claim.reply.send(Err(e));
                        }
                    }
                }
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => return Ok(()),
            }
        }

        while let Some(event) = conn.poll_for_event().map_err(|e| e.to_string())? {
            match event {
                Event::SelectionClear(_) => {
                    // Someone else claimed the selection — our offer is
                    // no longer valid to serve.
                    current = None;
                }
                Event::SelectionRequest(event) => {
                    handle_selection_request(&conn, &atoms, &mut current, event);
                }
                Event::DestroyNotify(_) => return Ok(()),
                _ => {}
            }
        }
    }
}

fn claim_selection(
    conn: &RustConnection,
    window: u32,
    atoms: &Atoms,
    entries: Vec<OfferEntry>,
    max_entry_bytes: usize,
) -> Result<ActiveOffer, String> {
    for entry in &entries {
        if let Payload::Bytes(bytes) = &entry.payload {
            if bytes.len() > max_entry_bytes {
                return Err(format!("offer entry '{}' is too large for one X11 property write", entry.target));
            }
        }
    }

    let atom_by_entry = entries
        .iter()
        .map(|entry| {
            conn.intern_atom(false, entry.target.as_bytes())
                .map_err(|e| e.to_string())?
                .reply()
                .map(|reply| reply.atom)
                .map_err(|e| e.to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;

    conn.set_selection_owner(window, atoms.CLIPBOARD, Time::CURRENT_TIME).map_err(|e| e.to_string())?;
    conn.flush().map_err(|e| e.to_string())?;

    // Confirm the claim landed before telling the caller it's safe to
    // inject a paste keystroke on a different X connection — a bare
    // `flush()` only guarantees the request was *sent*, not that the
    // server processed it yet (the exact ordering gap behind an earlier
    // bug this session; see the module doc comment).
    let owner = conn
        .get_selection_owner(atoms.CLIPBOARD)
        .map_err(|e| e.to_string())?
        .reply()
        .map_err(|e| e.to_string())?;
    if owner.owner != window {
        return Err("failed to become the clipboard selection owner".to_string());
    }

    Ok(ActiveOffer { entries, atom_by_entry, materialized: HashMap::new() })
}

fn handle_selection_request(
    conn: &RustConnection,
    atoms: &Atoms,
    current: &mut Option<ActiveOffer>,
    event: SelectionRequestEvent,
) {
    let success = respond(conn, atoms, current, &event).unwrap_or(false);
    let property = if success { event.property } else { AtomEnum::NONE.into() };
    let _ = conn.send_event(
        false,
        event.requestor,
        EventMask::NO_EVENT,
        SelectionNotifyEvent {
            response_type: SELECTION_NOTIFY_EVENT,
            sequence: event.sequence,
            time: event.time,
            requestor: event.requestor,
            selection: event.selection,
            target: event.target,
            property,
        },
    );
    let _ = conn.flush();
}

fn respond(
    conn: &RustConnection,
    atoms: &Atoms,
    current: &mut Option<ActiveOffer>,
    event: &SelectionRequestEvent,
) -> Result<bool, String> {
    let Some(offer) = current else { return Ok(false) };

    if event.target == atoms.TARGETS {
        let mut targets = offer.atom_by_entry.clone();
        targets.push(atoms.TARGETS);
        conn.change_property32(PropMode::REPLACE, event.requestor, event.property, atoms.ATOM, &targets)
            .map_err(|e| e.to_string())?;
        conn.flush().map_err(|e| e.to_string())?;
        return Ok(true);
    }

    let Some(index) = offer.atom_by_entry.iter().position(|&atom| atom == event.target) else {
        return Ok(false);
    };

    if !offer.materialized.contains_key(&index) {
        let bytes = match &offer.entries[index].payload {
            Payload::Bytes(bytes) => bytes.clone(),
            Payload::LazyPngFromFile(path) => encode_png(path)?,
        };
        offer.materialized.insert(index, bytes);
    }
    let bytes = &offer.materialized[&index];

    conn.change_property8(PropMode::REPLACE, event.requestor, event.property, event.target, bytes)
        .map_err(|e| e.to_string())?;
    conn.flush().map_err(|e| e.to_string())?;
    Ok(true)
}

fn encode_png(path: &std::path::Path) -> Result<Vec<u8>, String> {
    let decoded = image::open(path).map_err(|e| e.to_string())?.to_rgba8();
    let mut bytes = Vec::new();
    image::codecs::png::PngEncoder::new(&mut bytes)
        .write_image(decoded.as_raw(), decoded.width(), decoded.height(), image::ExtendedColorType::Rgba8)
        .map_err(|e| e.to_string())?;
    Ok(bytes)
}
