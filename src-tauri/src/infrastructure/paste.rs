use std::thread;
use std::time::Duration;

use arboard::Clipboard;
use enigo::{
    Direction::{Click, Press, Release},
    Enigo, Key, Keyboard, Settings,
};

use crate::domain::ports::{PasteInjector, PasteOutcome};
use crate::infrastructure::session_env::is_wayland;

const FOCUS_SETTLE_DELAY: Duration = Duration::from_millis(80);

pub struct SystemPasteInjector;

impl PasteInjector for SystemPasteInjector {
    fn paste(&self, text: &str) -> Result<PasteOutcome, String> {
        let mut clipboard = Clipboard::new().map_err(|e| e.to_string())?;
        clipboard.set_text(text).map_err(|e| e.to_string())?;
        self.paste_current_clipboard()
    }

    fn paste_current_clipboard(&self) -> Result<PasteOutcome, String> {
        if is_wayland() {
            return Ok(PasteOutcome::CopiedOnly);
        }

        #[cfg(target_os = "macos")]
        if !crate::infrastructure::platform::macos_accessibility::ensure_trusted_with_prompt() {
            // Not (yet) granted — enigo's CGEvent calls would silently do
            // nothing. The system permission dialog is now showing (or the
            // user already dismissed it before); report accurately rather
            // than claim a paste that didn't happen.
            return Ok(PasteOutcome::CopiedOnly);
        }

        thread::sleep(FOCUS_SETTLE_DELAY);

        #[cfg(target_os = "macos")]
        {
            on_main_thread(simulate_paste_keystroke)?
        }
        #[cfg(not(target_os = "macos"))]
        {
            simulate_paste_keystroke()?
        }

        Ok(PasteOutcome::Pasted)
    }
}

/// The actual Cmd+V/Ctrl+V simulation, factored out so it can be handed to
/// `on_main_thread` on macOS without that helper needing to know anything
/// about enigo.
fn simulate_paste_keystroke() -> Result<(), String> {
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
    let modifier = if cfg!(target_os = "macos") { Key::Meta } else { Key::Control };

    enigo.key(modifier, Press).map_err(|e| e.to_string())?;
    enigo.key(Key::Unicode('v'), Click).map_err(|e| e.to_string())?;
    enigo.key(modifier, Release).map_err(|e| e.to_string())?;
    Ok(())
}

/// `enigo`'s macOS backend resolves the layout-dependent keycode for
/// `Key::Unicode('v')` via `TSMGetInputSourceProperty` — a Text Services
/// Manager call that (like `NSScreen`, see `macos_panel.rs`'s own
/// `on_main_thread`) asserts it's running on the main thread and traps
/// (`SIGTRAP`/`EXC_BREAKPOINT`, not a catchable panic) if it isn't. Every
/// caller here reaches `paste_current_clipboard` from a tokio worker
/// thread (the extension bridge's async request handlers), never the
/// main thread, so this crashed the whole process on every real
/// paste — found live via a macOS crash report (not a Rust panic
/// backtrace) after "Paste Emoji" reliably took the app down.
///
/// Unlike `macos_panel.rs`'s version, there's no `AppHandle` in scope
/// here — `PasteInjector` is a domain-layer trait, and threading Tauri
/// specifics into it just to reach `run_on_main_thread` would leak the
/// dependency the trait exists to keep out. `dispatch2`'s main queue is
/// the same main-thread dispatch AppKit itself uses, and needs nothing
/// but the standard library on the call site.
#[cfg(target_os = "macos")]
fn on_main_thread<T: Send>(f: impl FnOnce() -> T + Send) -> T {
    use std::sync::mpsc;

    if objc2::MainThreadMarker::new().is_some() {
        return f();
    }
    let (tx, rx) = mpsc::channel();
    dispatch2::DispatchQueue::main().exec_sync(move || {
        let _ = tx.send(f());
    });
    rx.recv().expect("main thread dropped the result sender without running the task")
}
