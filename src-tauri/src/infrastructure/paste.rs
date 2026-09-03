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

/// How long to wait after writing the clipboard before the paste keystroke,
/// so the OS pasteboard has settled to the new value first.
const CLIPBOARD_SETTLE_DELAY: Duration = Duration::from_millis(30);
/// How long to wait after the paste keystroke before restoring the user's
/// previous clipboard, so the target app has read the pasted value. This is
/// the timing window called out in the plan's Open Questions.
const CLIPBOARD_RESTORE_DELAY: Duration = Duration::from_millis(140);

/// Sends `n` Backspace presses to the focused app — deletes an
/// auto-expansion's typed trigger before the expansion is pasted. A no-op
/// for `n == 0`, on Wayland, or (macOS) without Accessibility, so it is safe
/// to call headless. macOS routes through the main thread like every other
/// enigo call here (see `on_main_thread`).
pub(crate) fn delete_chars(n: usize) -> Result<(), String> {
    if n == 0 {
        return Ok(());
    }
    if is_wayland() {
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    if !crate::infrastructure::platform::macos_accessibility::is_trusted() {
        return Ok(());
    }
    press_key_n_times(Key::Backspace, n)
}

/// Sends `n` Left-Arrow presses — walks the caret back to a snippet's
/// `{cursor}` marker after pasting. Same no-op guards as `delete_chars`.
pub(crate) fn move_caret_left(n: usize) -> Result<(), String> {
    if n == 0 {
        return Ok(());
    }
    if is_wayland() {
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    if !crate::infrastructure::platform::macos_accessibility::is_trusted() {
        return Ok(());
    }
    press_key_n_times(Key::LeftArrow, n)
}

fn press_key_n_times(key: Key, n: usize) -> Result<(), String> {
    let run = move || -> Result<(), String> {
        let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
        for _ in 0..n {
            enigo.key(key, Click).map_err(|e| e.to_string())?;
        }
        Ok(())
    };
    #[cfg(target_os = "macos")]
    {
        on_main_thread(run)
    }
    #[cfg(not(target_os = "macos"))]
    {
        run()
    }
}

/// Replaces a just-typed snippet keyword in the focused app with its
/// expanded text, in place, preserving the user's clipboard and placing the
/// caret at the snippet's `{cursor}` marker. The whole sequence auto-expansion
/// needs (steps ②–⑦ in the module plan):
///
/// 1. Save the user's current clipboard.
/// 2. Put `text` on the clipboard (suppressing it, and later the restored
///    value, from clipboard history via `suppress`).
/// 3. Delete `backspaces` characters — the typed keyword (+ delimiter).
/// 4. Paste (Cmd/Ctrl+V).
/// 5. Restore the saved clipboard.
/// 6. Move the caret left to `cursor_offset` (`LeftArrow` × remaining chars).
///
/// Returns `CopiedOnly` (doing nothing) on Wayland or without macOS
/// Accessibility, matching `paste_current_clipboard`'s honesty contract —
/// though `AutoExpander::available()` already gates those out before here.
pub(crate) fn expand_in_place(text: &str, cursor_offset: usize, backspaces: usize, suppress: impl Fn(&str)) -> Result<PasteOutcome, String> {
    if is_wayland() {
        return Ok(PasteOutcome::CopiedOnly);
    }
    #[cfg(target_os = "macos")]
    if !crate::infrastructure::platform::macos_accessibility::ensure_trusted_with_prompt() {
        return Ok(PasteOutcome::CopiedOnly);
    }

    let mut clipboard = Clipboard::new().map_err(|e| e.to_string())?;
    let previous = clipboard.get_text().ok();

    suppress(text);
    clipboard.set_text(text).map_err(|e| e.to_string())?;
    thread::sleep(CLIPBOARD_SETTLE_DELAY);

    delete_chars(backspaces)?;

    #[cfg(target_os = "macos")]
    {
        on_main_thread(simulate_paste_keystroke)?
    }
    #[cfg(not(target_os = "macos"))]
    {
        simulate_paste_keystroke()?
    }

    thread::sleep(CLIPBOARD_RESTORE_DELAY);
    match previous {
        Some(prev) => {
            suppress(&prev);
            let _ = clipboard.set_text(prev);
        }
        None => {
            let _ = clipboard.clear();
        }
    }

    let lefts = text.chars().count().saturating_sub(cursor_offset);
    move_caret_left(lefts)?;

    Ok(PasteOutcome::Pasted)
}

/// The actual Cmd+V/Ctrl+V simulation, factored out so it can be handed to
/// `on_main_thread` on macOS without that helper needing to know anything
/// about enigo.
fn simulate_paste_keystroke() -> Result<(), String> {
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;

    // On macOS, press V by its raw virtual keycode (`kVK_ANSI_V` = 9) rather
    // than `Key::Unicode('v')`. enigo's Unicode path resolves the keycode via
    // `TSMGetInputSourceProperty` (Text Services Manager), which aborts the
    // process (SIGABRT in HIToolbox, even on the main thread) on a real Mac —
    // found live the first time auto-expansion exercised this path, which
    // paste injection's "known-gap" status meant nothing had before. The raw
    // keycode skips that lookup entirely.
    #[cfg(target_os = "macos")]
    {
        const KVK_ANSI_V: u32 = 9;
        enigo.key(Key::Meta, Press).map_err(|e| e.to_string())?;
        enigo.key(Key::Other(KVK_ANSI_V), Click).map_err(|e| e.to_string())?;
        enigo.key(Key::Meta, Release).map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        enigo.key(Key::Control, Press).map_err(|e| e.to_string())?;
        enigo.key(Key::Unicode('v'), Click).map_err(|e| e.to_string())?;
        enigo.key(Key::Control, Release).map_err(|e| e.to_string())?;
    }
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
pub(crate) fn on_main_thread<T: Send>(f: impl FnOnce() -> T + Send) -> T {
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

#[cfg(test)]
mod tests {
    use super::*;

    /// `n == 0` must be a pure no-op — no enigo, no permission prompt — so
    /// these are safe to call in a headless test run regardless of platform.
    #[test]
    fn delete_and_caret_are_no_ops_for_zero() {
        assert!(delete_chars(0).is_ok());
        assert!(move_caret_left(0).is_ok());
    }
}
