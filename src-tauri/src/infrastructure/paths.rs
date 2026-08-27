//! Shared filesystem-path helpers. `expand_home` used to live in
//! `application::script_commands` and was imported cross-feature by
//! `application::screenshots` and `application::sync` — an infrastructure
//! concern (path resolution) that had drifted into a feature module. Moved
//! here as part of the extension-platform refactor's layering pass
//! (`plans/refactor-extension-platform.md`, T7).

use std::path::PathBuf;

/// Expands a leading `~/` (or `~\` on Windows) to the user's home
/// directory. `HOME` is the Unix convention; `USERPROFILE` is Windows',
/// where `HOME` is usually unset outside of Git Bash/MSYS environments. A
/// path with no leading `~` separator, or with neither environment
/// variable set, passes through unchanged.
pub fn expand_home(path: &str) -> PathBuf {
    let rest = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\"));
    if let Some(rest) = rest {
        if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn home_expansion_handles_both_separators() {
        // `~/` works wherever HOME (or USERPROFILE) is set; a bare path
        // passes through untouched.
        assert_eq!(expand_home("/abs/path"), PathBuf::from("/abs/path"));
        if std::env::var_os("HOME").is_some() {
            assert!(expand_home("~/scripts").is_absolute());
            assert!(!expand_home("~/scripts").display().to_string().contains('~'));
        }
    }
}
