//! Whether an extension says it supports the platform we're running on.
//!
//! Raycast gates this at install time with a manifest `platforms` array
//! (`["macOS"]`, `["macOS", "Windows"]`), and treats an *absent* field as
//! `["macOS"]`. We deliberately read absence differently — see
//! [`PlatformSupport::Unknown`].

/// What a manifest's `platforms` says about the current OS.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlatformSupport {
    /// Declared, and includes us.
    Supported,
    /// Declared, and doesn't include us.
    Unsupported,
    /// No `platforms` field at all.
    ///
    /// Raycast would call this macOS-only. We don't: 72 of 180 sampled
    /// extensions omit the field simply because they predate it, and only
    /// 3 of those touch a macOS-only API. Treating absence as a refusal
    /// would exclude most of the catalogue to catch a handful of cases the
    /// capability check already handles better.
    Unknown,
}

/// The name this platform goes by in a Raycast manifest.
pub fn current_platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macOS"
    } else if cfg!(target_os = "windows") {
        "Windows"
    } else {
        "Linux"
    }
}

pub fn evaluate(platforms: Option<&Vec<String>>) -> PlatformSupport {
    let Some(platforms) = platforms else { return PlatformSupport::Unknown };
    if platforms.is_empty() {
        return PlatformSupport::Unknown;
    }
    let current = current_platform();
    if platforms.iter().any(|p| p.eq_ignore_ascii_case(current)) {
        PlatformSupport::Supported
    } else {
        PlatformSupport::Unsupported
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn an_absent_field_is_unknown_not_a_refusal() {
        // The deliberate divergence from Raycast: most of the catalogue
        // predates the field and is perfectly portable.
        assert_eq!(evaluate(None), PlatformSupport::Unknown);
        assert_eq!(evaluate(Some(&v(&[]))), PlatformSupport::Unknown);
    }

    #[test]
    fn matches_the_current_platform_case_insensitively() {
        assert_eq!(evaluate(Some(&v(&[current_platform()]))), PlatformSupport::Supported);
        let shouted = current_platform().to_uppercase();
        assert_eq!(evaluate(Some(&v(&[&shouted]))), PlatformSupport::Supported);
    }

    #[test]
    fn reports_a_declared_platform_that_is_not_ours() {
        let other = if current_platform() == "macOS" { "Windows" } else { "macOS" };
        assert_eq!(evaluate(Some(&v(&[other]))), PlatformSupport::Unsupported);
    }

    #[test]
    fn a_multi_platform_list_counts_if_it_includes_us() {
        assert_eq!(evaluate(Some(&v(&["macOS", "Windows", "Linux"]))), PlatformSupport::Supported);
    }
}
