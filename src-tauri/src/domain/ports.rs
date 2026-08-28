use crate::domain::command::Command;

pub trait CommandProvider: Send + Sync {
    fn commands(&self) -> Vec<Command>;
    fn execute(&self, command_id: &str) -> Result<(), String>;

    /// Runs a command with the arguments its manifest declares, keyed by
    /// name. A command may declare several (Raycast allows up to three), so
    /// a single anonymous string can't express what was collected.
    fn execute_with_arguments(
        &self,
        command_id: &str,
        arguments: &std::collections::HashMap<String, String>,
    ) -> Result<(), String> {
        let _ = arguments;
        self.execute(command_id)
    }

    /// Cache-invalidation hook for `CommandRegistry`: the default, `None`,
    /// means this provider's `commands()` is re-fetched on every registry
    /// access — the original, always-correct behavior, unchanged for any
    /// provider that doesn't override this. A provider backed by
    /// expensive I/O (a SQLite query, a filesystem scan) can opt into
    /// caching by returning `Some(generation)` — a counter it bumps
    /// itself after any write that could change its command set. The
    /// registry re-fetches `commands()` only when this value changes
    /// since the last call it made; between changes, it reuses the
    /// cached list — zero I/O, not merely cheap I/O. Never a time-based
    /// TTL: a provider that doesn't bump its counter after a real write
    /// would otherwise serve stale results indefinitely.
    fn generation(&self) -> Option<u64> {
        None
    }
}

#[derive(Debug, Clone)]
pub struct InstalledApp {
    pub id: String,
    pub name: String,
    pub icon: Option<String>,
}

pub trait AppScanner: Send + Sync {
    fn scan(&self) -> Vec<InstalledApp>;
    fn launch(&self, app_id: &str) -> Result<(), String>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasteOutcome {
    Pasted,
    CopiedOnly,
}

pub trait PasteInjector: Send + Sync {
    fn paste(&self, text: &str) -> Result<PasteOutcome, String>;

    /// Sends the paste keystroke for whatever is *already* on the
    /// clipboard, for content that can't be round-tripped through
    /// `paste`'s `&str` (images). Defaults to `CopiedOnly` — an injector
    /// that can't synthesise input has still left the content on the
    /// clipboard for the user to paste themselves.
    fn paste_current_clipboard(&self) -> Result<PasteOutcome, String> {
        Ok(PasteOutcome::CopiedOnly)
    }
}

/// Reads whatever text is currently *selected* (not copied) in whichever
/// window has focus — `host.system.getSelectedText`'s backing port.
pub trait SelectionReader: Send + Sync {
    /// `None` covers both "nothing is selected" and "this
    /// platform/session has no way to read a live selection" (X11 PRIMARY
    /// has no Wayland equivalent) — indistinguishable until a real
    /// `capabilities` surface (T12) lets a caller check ahead of calling.
    fn read_selected_text(&self) -> Option<String>;
}

/// Moves a filesystem path to the OS trash/recycle bin (not a permanent
/// delete) — `host.system.trash`'s backing port.
pub trait Trash: Send + Sync {
    fn trash(&self, path: &str) -> Result<(), String>;
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontmostApplication {
    pub name: String,
    pub path: Option<String>,
    pub bundle_id: Option<String>,
}

/// Identifies the application that currently has input focus —
/// `host.system.getFrontmostApplication`'s backing port. Distinct from
/// this app's own focus-restore bookkeeping (`linux_focus`/`windows_focus`/
/// `macos_accessibility`, which only ever needs a window handle to give
/// focus back to) — this resolves that focused window all the way to an
/// application identity.
pub trait FrontmostAppReader: Send + Sync {
    /// `None` when there's no focused window to resolve (nothing focused,
    /// or resolution failed) — best-effort, matching `PasteInjector`'s
    /// posture toward platform calls that can fail for reasons outside
    /// this app's control.
    fn frontmost_application(&self) -> Option<FrontmostApplication>;
}
