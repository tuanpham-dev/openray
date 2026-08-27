const RECENCY_HALF_LIFE_SECS: f64 = 60.0 * 60.0 * 24.0 * 4.0;

pub fn frecency_score(hits: u32, last_used_at: i64, now: i64) -> f64 {
    if hits == 0 {
        return 0.0;
    }
    let age_secs = (now - last_used_at).max(0) as f64;
    let recency_weight = 0.5f64.powf(age_secs / RECENCY_HALF_LIFE_SECS);
    hits as f64 * recency_weight
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn used_command_outranks_unused_equal_score_match() {
        let now = 1_000_000;
        let used = frecency_score(3, now - 3600, now);
        let unused = frecency_score(0, 0, now);
        assert!(used > unused);
    }

    #[test]
    fn recent_usage_outranks_stale_usage_with_equal_hits() {
        let now = 1_000_000;
        let recent = frecency_score(5, now - 3600, now);
        let stale = frecency_score(5, now - (RECENCY_HALF_LIFE_SECS as i64) * 10, now);
        assert!(recent > stale);
    }

    #[test]
    fn score_decays_to_roughly_half_after_one_half_life() {
        let now = RECENCY_HALF_LIFE_SECS as i64;
        let fresh = frecency_score(10, now, now);
        let one_half_life_old = frecency_score(10, 0, now);
        assert!((one_half_life_old - fresh / 2.0).abs() < 0.001);
    }
}
