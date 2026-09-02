//! Watches for `NSApplicationDidChangeScreenParametersNotification` — the
//! only signal macOS gives that a display was connected, disconnected, or
//! reconfigured (resolution/scaling/arrangement) while the app is already
//! running.
//!
//! Nothing else in this codebase observes this. `window_manage::macos`'s
//! `displays()` re-queries `NSScreen::screens` live on every call, so the
//! *data* is never stale — but Window Management's `next-display`/
//! `previous-display` root-search rows are a **push**, not a pull
//! (`application::root_commands`'s `RootCommandProvider::set_rows` only
//! updates when the extension's root-provider listing is explicitly
//! re-requested, e.g. `lib.rs`'s one-time `spawn_root_provider_startup` at
//! host start, or an extension calling `refreshRootCommands()` itself).
//! Found live: connecting a second monitor mid-session left those two rows
//! missing from search until something unrelated (creating a custom window
//! command) happened to trigger a refresh — the display list was correct
//! the whole time, root search just never asked again.

use std::cell::OnceCell;
use std::ptr::NonNull;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2_app_kit::NSApplicationDidChangeScreenParametersNotification;
use objc2_foundation::{NSNotification, NSNotificationCenter, NSObjectProtocol};

thread_local! {
    // The registration must outlive the call that creates it
    // (`removeObserver` is never needed — this is meant to watch for the
    // app's entire lifetime), so it's parked here rather than dropped.
    // `thread_local!`, not a plain `static`, because `Retained<ProtocolObject<_>>`
    // isn't `Sync` — correctly so, since ObjC objects aren't safe to touch
    // from just any thread — and this one is only ever touched from the
    // main thread anyway (see `watch`'s doc comment).
    static OBSERVER: OnceCell<Retained<ProtocolObject<dyn NSObjectProtocol>>> = const { OnceCell::new() };
}

/// Registers `on_change` to run on the main thread every time macOS posts
/// a screen-parameters-changed notification. Must itself be called on the
/// main thread (same requirement as every other AppKit call in this
/// codebase — see `macos_panel`'s own `on_main_thread`); `lib.rs`'s
/// `.setup()` closure, the intended call site, already runs there.
/// Idempotent — a second call is a no-op, since one process-lifetime
/// observer is all this ever needs.
pub fn watch(on_change: impl Fn() + Send + 'static) {
    OBSERVER.with(|cell| {
        if cell.get().is_some() {
            return;
        }
        let block = RcBlock::new(move |_note: NonNull<NSNotification>| on_change());
        let observer = unsafe {
            let name = NSApplicationDidChangeScreenParametersNotification;
            NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(Some(name), None, None, &block)
        };
        let _ = cell.set(observer);
    });
}
