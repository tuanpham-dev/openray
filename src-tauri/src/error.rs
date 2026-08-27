//! Crate-wide error type for platform code (`infrastructure/` and
//! `application::sync`). Feature modules (notes, snippets, translate, AI,
//! etc.) keep their existing `Result<_, String>` signatures — they're
//! slated for deletion as the extension-platform migration proceeds
//! (`plans/refactor-extension-platform.md`), so restructuring their error
//! handling now would be wasted work.
//!
//! `Message` is the catch-all for the many existing handwritten error
//! strings (`format!("note '{id}' not found")` and friends) migrated
//! as-is — its `Display` echoes the string verbatim, with no added
//! decoration, so string-prefix conventions a caller depends on (e.g.
//! `extension_commands::launch`'s `missing_required_preferences:` prefix,
//! parsed by the frontend) survive unchanged through `Error::to_string()`.
//!
//! `api/` commands stay `Result<_, String>` (Tauri's IPC boundary needs a
//! `Serialize` error type, and `String` is what the frontend already
//! parses); the `From<Error> for String` impl below lets every `api/`
//! command that calls into converted platform code keep using `?`
//! unchanged.

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),

    #[error(transparent)]
    Io(#[from] std::io::Error),

    #[error(transparent)]
    Json(#[from] serde_json::Error),

    #[error(transparent)]
    Tauri(#[from] tauri::Error),

    #[error(transparent)]
    Host(#[from] crate::infrastructure::extension_host::process::HostError),

    #[error(transparent)]
    Crypto(#[from] crate::application::sync::crypto::CryptoError),

    /// Catch-all for handwritten, ad-hoc messages — the overwhelmingly
    /// common case in the code being migrated onto this type. Construct
    /// with `Error::msg("...")`, `.into()` on a `String`/`&str`, or via
    /// `?` from a function returning `Result<_, String>`.
    #[error("{0}")]
    Message(String),
}

impl Error {
    pub fn msg(message: impl Into<String>) -> Self {
        Error::Message(message.into())
    }
}

impl From<String> for Error {
    fn from(message: String) -> Self {
        Error::Message(message)
    }
}

impl From<&str> for Error {
    fn from(message: &str) -> Self {
        Error::Message(message.to_string())
    }
}

/// The one conversion point back to `String`, used at the `api/` layer
/// (Tauri commands) so callers can keep `-> Result<_, String>` and use
/// `?` on functions that now return `Result<_, Error>`.
impl From<Error> for String {
    fn from(error: Error) -> Self {
        error.to_string()
    }
}
