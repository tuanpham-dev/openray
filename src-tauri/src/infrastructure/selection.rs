use crate::domain::ports::SelectionReader;

pub struct SystemSelectionReader;

impl SelectionReader for SystemSelectionReader {
    /// Linux/X11 reads the PRIMARY selection directly — no clipboard
    /// interaction, no synthesized keystroke, and it reflects whatever's
    /// selected *right now* rather than whatever was last explicitly
    /// copied. Wayland has no equivalent concept at all (`None`, not an
    /// empty selection — matches this trait's doc comment on the
    /// distinction being unavailable until T12's `capabilities` surface).
    ///
    /// macOS/Windows have no live-selection API this codebase already
    /// uses (a real fix needs Accessibility/UIA text-range reads) — the
    /// plan's own sanctioned fallback is a synthesized copy: save
    /// whatever's on the clipboard, send the platform's copy keystroke,
    /// read the clipboard, then restore the original content. Best-effort
    /// and briefly touches the real clipboard, exactly as flagged in the
    /// refactor plan's Open Questions.
    fn read_selected_text(&self) -> Option<String> {
        #[cfg(target_os = "linux")]
        {
            use arboard::{GetExtLinux, LinuxClipboardKind};
            arboard::Clipboard::new()
                .and_then(|mut clipboard| clipboard.get().clipboard(LinuxClipboardKind::Primary).text())
                .ok()
        }

        #[cfg(not(target_os = "linux"))]
        {
            synthesized_copy_selection()
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn synthesized_copy_selection() -> Option<String> {
    use std::thread;
    use std::time::Duration;

    use enigo::{
        Direction::{Click, Press, Release},
        Enigo, Key, Keyboard, Settings,
    };

    #[cfg(target_os = "macos")]
    if !crate::infrastructure::platform::macos_accessibility::ensure_trusted_with_prompt() {
        return None;
    }

    let mut clipboard = arboard::Clipboard::new().ok()?;
    let previous = clipboard.get_text().ok();

    // A copy keystroke with nothing selected is a no-op in most apps —
    // without this, that case would silently return whatever was already
    // on the clipboard as if it were the live selection. Setting a
    // sentinel first turns "the clipboard still holds the sentinel" into
    // a reliable "nothing was selected" signal.
    let sentinel = format!("\u{0}openray-selection-probe-{}\u{0}", crate::infrastructure::time::now_nanos());
    clipboard.set_text(sentinel.clone()).ok()?;

    let mut enigo = Enigo::new(&Settings::default()).ok()?;
    let modifier = if cfg!(target_os = "macos") { Key::Meta } else { Key::Control };
    enigo.key(modifier, Press).ok()?;
    enigo.key(Key::Unicode('c'), Click).ok()?;
    enigo.key(modifier, Release).ok()?;

    // The target app needs a moment to actually place the selection on
    // the clipboard in response to the synthesized keystroke before this
    // reads it back — the same settle-delay reasoning `paste.rs` uses
    // before its own synthesized keystroke.
    thread::sleep(Duration::from_millis(80));

    let after = clipboard.get_text().ok();

    if let Some(text) = &previous {
        let _ = clipboard.set_text(text.clone());
    } else {
        let _ = clipboard.clear();
    }

    match after {
        Some(text) if text != sentinel && !text.is_empty() => Some(text),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// No X server (or nothing selected) is a completely normal outcome
    /// in a headless test run — this only proves the call is safe to make
    /// at all, never panicking regardless of environment.
    #[test]
    fn read_selected_text_does_not_panic_with_no_live_session() {
        let _ = SystemSelectionReader.read_selected_text();
    }
}
