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

        let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
        let modifier = if cfg!(target_os = "macos") { Key::Meta } else { Key::Control };

        enigo.key(modifier, Press).map_err(|e| e.to_string())?;
        enigo.key(Key::Unicode('v'), Click).map_err(|e| e.to_string())?;
        enigo.key(modifier, Release).map_err(|e| e.to_string())?;

        Ok(PasteOutcome::Pasted)
    }
}
