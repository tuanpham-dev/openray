//! Shared "now" accessors. Before this module existed, `now_unix()` (10
//! copies) and `now_nanos()` (6 copies) were hand-rolled identically in
//! every feature module that needed a timestamp or a `<kind>.<nanos>` row
//! id, plus one differently-named `now_ms()` in `application::sync`. Moved
//! here as part of the extension-platform refactor's layering pass
//! (`plans/refactor-extension-platform.md`, T8) — each call site keeps its
//! own local name via a `use ... as ...` import (e.g. `use
//! crate::infrastructure::time::now_secs as now_unix;`), so no call site
//! anywhere in the codebase needed to change, only where the
//! implementation comes from.
//!
//! `EPOCH` and `to_unix_secs` exist so a caller that needs `UNIX_EPOCH`
//! for something other than "now" (a fallback sentinel, converting an
//! arbitrary `SystemTime`) doesn't have to import `std::time::UNIX_EPOCH`
//! directly — see `application::screenshots`'s `unix_secs` for the
//! motivating case.

use std::time::{SystemTime, UNIX_EPOCH};

pub const EPOCH: SystemTime = UNIX_EPOCH;

pub fn now_secs() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64
}

/// `unwrap_or_default()`, not `unwrap()` — matches `application::sync`'s
/// original `now_ms`, whose only caller (timestamping a sync event) needs
/// this to stay infallible rather than panic on a clock set before 1970.
pub fn now_millis() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64
}

pub fn now_nanos() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
}

/// Converts an arbitrary `SystemTime` (not "now") to unix seconds,
/// returning `None` only if `time` predates the epoch.
pub fn to_unix_secs(time: SystemTime) -> Option<i64> {
    time.duration_since(UNIX_EPOCH).ok().map(|d| d.as_secs() as i64)
}

/// The `<prefix>.<nanos>` row-id shape used across several feature
/// modules (`snippet.<nanos>`, `quicklink.<nanos>`, `ai.chat.<nanos>`,
/// …). The 8 existing call sites predating this helper weren't migrated
/// onto it — see T8's plan note for why (each is a persisted key whose
/// exact string format isn't worth the risk of touching for a one-line
/// `format!` call, especially in modules already scheduled for deletion
/// as their features migrate to extensions) — but new code (T11's
/// `ConfirmAlertRegistry` request ids) uses it directly.
pub fn new_row_id(prefix: &str) -> String {
    format!("{prefix}.{}", now_nanos())
}

/// A random v4-shaped identifier, built from the OS RNG via `getrandom`
/// (already in the dependency tree) rather than adding a uuid crate.
/// Moved here from the now-deleted `application::placeholders` (T27 —
/// that module's `{uuid}` placeholder expansion was AI-only; sync's own
/// use of this function is its only surviving caller).
pub fn pseudo_uuid() -> String {
    let mut bytes = [0u8; 16];
    if getrandom::fill(&mut bytes).is_err() {
        // Falling back to the clock keeps this infallible; uniqueness is
        // best-effort either way here.
        let nanos = SystemTime::now().duration_since(EPOCH).unwrap_or_default().as_nanos();
        bytes.copy_from_slice(&nanos.to_le_bytes());
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn now_secs_is_a_plausible_unix_timestamp() {
        // Bounds: released well after 2020-01-01, well before any
        // plausible clock error would put it past 2100-01-01.
        let secs = now_secs();
        assert!(secs > 1_577_836_800, "expected a timestamp after 2020, got {secs}");
        assert!(secs < 4_102_444_800, "expected a timestamp before 2100, got {secs}");
    }

    #[test]
    fn now_millis_and_now_nanos_agree_with_now_secs_within_one_second() {
        let secs = now_secs();
        let millis = now_millis();
        let nanos = now_nanos();
        assert!((millis / 1000 - secs).abs() <= 1);
        assert!((nanos / 1_000_000_000 - secs as u128).abs_diff(0) <= 1);
    }

    #[test]
    fn to_unix_secs_round_trips_now() {
        let now = SystemTime::now();
        let secs = to_unix_secs(now).unwrap();
        assert!((secs - now_secs()).abs() <= 1);
    }

    #[test]
    fn to_unix_secs_is_none_before_the_epoch() {
        let before = EPOCH - std::time::Duration::from_secs(1);
        assert_eq!(to_unix_secs(before), None);
    }

    #[test]
    fn new_row_id_uses_the_dot_separated_prefix_nanos_shape() {
        let id = new_row_id("snippet");
        assert!(id.starts_with("snippet."));
        let nanos_part = id.strip_prefix("snippet.").unwrap();
        assert!(nanos_part.parse::<u128>().is_ok(), "expected numeric nanos suffix, got {nanos_part}");
    }

    #[test]
    fn pseudo_uuid_is_v4_shaped_and_unique() {
        let first = pseudo_uuid();
        let second = pseudo_uuid();
        assert_ne!(first, second);
        assert_eq!(first.len(), 36);
        assert_eq!(&first[14..15], "4");
    }
}
