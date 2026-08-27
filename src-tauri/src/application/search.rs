use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher};

use crate::domain::command::Command;

/// Bonus added to a fuzzy match score when the query matches the command's
/// alias — large enough to always outrank a pure title/keyword match, but
/// distinguishing an exact alias (should win outright) from a prefix of it
/// (should still lead, but not eclipse an equally-exact title match on
/// another command).
const ALIAS_EXACT_BONUS: f64 = 1_000_000.0;
const ALIAS_PREFIX_BONUS: f64 = 1_000.0;
/// Below the alias bonuses (an assigned alias should still win outright)
/// but large enough to break the fuzzy matcher's ties in favor of a
/// command whose title is the query verbatim — without this, a query like
/// "center" can score identically against "Center" and a longer title
/// that merely contains "center" as a substring (e.g. "Top Center
/// Sixth"), and the tie then falls to whichever command happened to come
/// first in provider-registration order. Caught live: Window Management's
/// preset table lists sixths before Center, so "center" surfaced "Top
/// Center Sixth" first.
const TITLE_EXACT_BONUS: f64 = 500_000.0;
const TITLE_PREFIX_BONUS: f64 = 500.0;

struct Haystack {
    index: usize,
    text: String,
}

impl AsRef<str> for Haystack {
    fn as_ref(&self) -> &str {
        &self.text
    }
}

fn alias_bonus(command_id: &str, aliases: &HashMap<String, String>, query_lower: &str) -> f64 {
    let Some(alias) = aliases.get(command_id) else { return 0.0 };
    let alias_lower = alias.to_lowercase();
    if alias_lower == query_lower {
        ALIAS_EXACT_BONUS
    } else if !query_lower.is_empty() && alias_lower.starts_with(query_lower) {
        ALIAS_PREFIX_BONUS
    } else {
        0.0
    }
}

fn title_bonus(title: &str, query_lower: &str) -> f64 {
    let title_lower = title.to_lowercase();
    if title_lower == query_lower {
        TITLE_EXACT_BONUS
    } else if !query_lower.is_empty() && title_lower.starts_with(query_lower) {
        TITLE_PREFIX_BONUS
    } else {
        0.0
    }
}

/// Per-character nucleo-score cutoffs for `searchSensitivity`, calibrated
/// against a corpus of the app's own bundled command titles (Phase 2 T3a
/// of `plans/raycast-settings-parity.md` — see
/// `tests::print_sensitivity_calibration_scores` to reproduce). Scattered,
/// non-word-boundary subsequence matches (e.g. "ai" buried in "cre-A-te
/// w-I-ndow...") scored 12.0–13.0 per character; realistic compact
/// queries — word-initial subsequences and consonant skeletons a user
/// would actually type ("wm" → Window Management, "cmd" → Create AI
/// Command) — scored 20.0+ ; clean prefix/exact-word matches scored
/// 25.0–29.3. `medium` sits above the junk cluster with margin; `high`
/// sits closer to (but still safely under) the realistic-compact floor,
/// giving it room to catch noisier junk `medium` wouldn't.
fn sensitivity_cutoff(sensitivity: &str) -> f64 {
    match sensitivity {
        "medium" => 16.0,
        "high" => 19.0,
        _ => 0.0, // "low" (and any unrecognized value — already clamped upstream): today's behavior.
    }
}

/// Scores every haystack against `pattern`, using the *weakest*-matching
/// word (nucleo "atom") as the score, not `Pattern::score`'s own sum of
/// every word's score — `Pattern::parse` already splits a multi-word query
/// on spaces into independently-fuzzy-matched atoms (`pattern_atoms` in
/// `nucleo_matcher`), so a query like "ai command" becomes two atoms, "ai"
/// and "command", each scored separately and (in nucleo's own
/// `Pattern::score`) simply added together.
///
/// Found live: "ai command" ranked "Create Window Command"/"Search Window
/// Commands" competitively with the actually-relevant "Search AI
/// Commands"/"Create AI Command" — every one of these titles/keyword
/// blobs contains the word "command"/"commands" almost verbatim, so that
/// atom scores ~192 for all four regardless of relevance; what should
/// discriminate them is the "ai" atom, which scores ~62 for the AI
/// commands (a real word-boundary match) but only ~25 for the window
/// commands (a weak, scattered subsequence match buried inside "cre-A-te
/// w-I-ndow..."). Summing washes that out: 254 vs. 218/217 is barely a
/// 15% gap, well within reach of a frecency bump. Taking the minimum
/// instead makes the actual discriminating word dominate: 62 vs. 25 is a
/// ~2.5x gap. A single-word query is unaffected either way — the minimum
/// of one value is that value, identical to `Pattern::score`'s sum.
///
/// `query_words` must be `query.split_whitespace().collect()` on the same
/// trimmed query string `pattern` was parsed from — `Atom` exposes no
/// public accessor for its own char length, so `sensitivity_cutoff`'s
/// per-atom check recovers it by zipping atoms back up with the words they
/// came from (`Pattern::parse` splits one atom per whitespace-separated
/// word, absent escaped spaces, same convention `print_sensitivity_calibration_scores` uses).
fn match_list_by_weakest_word(
    pattern: &Pattern,
    query_words: &[&str],
    sensitivity: &str,
    haystacks: Vec<Haystack>,
    matcher: &mut Matcher,
) -> Vec<(Haystack, u32)> {
    if pattern.atoms.is_empty() {
        return haystacks.into_iter().map(|h| (h, 0)).collect();
    }
    let cutoff_per_char = sensitivity_cutoff(sensitivity);
    let mut buf = Vec::new();
    let mut scored: Vec<(Haystack, u32)> = haystacks
        .into_iter()
        .filter_map(|h| {
            let utf32 = nucleo_matcher::Utf32Str::new(&h.text, &mut buf);
            let mut min_score: Option<u32> = None;
            for (atom, word) in pattern.atoms.iter().zip(query_words.iter()) {
                let score = atom.score(utf32, matcher)? as u32;
                if cutoff_per_char > 0.0 {
                    let atom_chars = word.chars().count().max(1) as f64;
                    if (score as f64) < cutoff_per_char * atom_chars {
                        return None;
                    }
                }
                min_score = Some(min_score.map_or(score, |m| m.min(score)));
            }
            min_score.map(|score| (h, score))
        })
        .collect();
    scored.sort_by_key(|(_, score)| std::cmp::Reverse(*score));
    scored
}

pub fn search(
    commands: &[Command],
    query: &str,
    frecency_scores: &HashMap<String, f64>,
    aliases: &HashMap<String, String>,
    disabled: &HashSet<String>,
    sensitivity: &str,
) -> Vec<Command> {
    let commands: Vec<Command> = commands.iter().filter(|c| !disabled.contains(&c.id)).cloned().collect();
    let trimmed = query.trim();

    if trimmed.is_empty() {
        let mut sorted = commands;
        sorted.sort_by(|a, b| compare_frecency(a, b, frecency_scores));
        return sorted;
    }

    let mut matcher = Matcher::new(Config::DEFAULT);
    let haystacks: Vec<Haystack> = commands
        .iter()
        .enumerate()
        .map(|(index, command)| {
            let alias = aliases.get(&command.id).map(String::as_str).unwrap_or("");
            Haystack { index, text: format!("{} {} {}", command.title, command.keywords.join(" "), alias) }
        })
        .collect();

    let pattern = Pattern::parse(trimmed, CaseMatching::Ignore, Normalization::Smart);
    let query_words: Vec<&str> = trimmed.split_whitespace().collect();
    let mut matches = match_list_by_weakest_word(&pattern, &query_words, sensitivity, haystacks, &mut matcher);
    let query_lower = trimmed.to_lowercase();

    matches.sort_by(|(a, match_score_a), (b, match_score_b)| {
        let command_a = &commands[a.index];
        let command_b = &commands[b.index];
        let frecency_a = frecency_scores.get(&command_a.id).copied().unwrap_or(0.0);
        let frecency_b = frecency_scores.get(&command_b.id).copied().unwrap_or(0.0);
        let combined_a = *match_score_a as f64
            + frecency_a * 10.0
            + alias_bonus(&command_a.id, aliases, &query_lower)
            + title_bonus(&command_a.title, &query_lower);
        let combined_b = *match_score_b as f64
            + frecency_b * 10.0
            + alias_bonus(&command_b.id, aliases, &query_lower)
            + title_bonus(&command_b.title, &query_lower);
        combined_b.partial_cmp(&combined_a).unwrap_or(Ordering::Equal)
    });

    matches.into_iter().map(|(h, _)| commands[h.index].clone()).collect()
}

fn compare_frecency(a: &Command, b: &Command, frecency_scores: &HashMap<String, f64>) -> Ordering {
    let score_a = frecency_scores.get(&a.id).copied().unwrap_or(0.0);
    let score_b = frecency_scores.get(&b.id).copied().unwrap_or(0.0);
    score_b.partial_cmp(&score_a).unwrap_or(Ordering::Equal)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::command::CommandKind;

    fn command(id: &str, title: &str) -> Command {
        command_with_keywords(id, title, &[])
    }

    fn command_with_keywords(id: &str, title: &str, keywords: &[&str]) -> Command {
        Command {
            id: id.into(),
            title: title.into(),
            subtitle: None,
            icon: None,
            kind: CommandKind::App,
            keywords: keywords.iter().map(|k| k.to_string()).collect(),
            requires_argument: false,
        }
    }

    #[test]
    fn filters_out_non_matching_commands() {
        let commands = vec![command("firefox", "Firefox"), command("calc", "Calculator")];
        let results = search(&commands, "fire", &HashMap::new(), &HashMap::new(), &HashSet::new(), "low");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, "firefox");
    }

    #[test]
    fn frecency_breaks_ties_between_equally_good_matches() {
        let commands = vec![command("a", "Test App"), command("b", "Test App")];
        let mut frecency = HashMap::new();
        frecency.insert("b".to_string(), 5.0);

        let results = search(&commands, "test", &frecency, &HashMap::new(), &HashSet::new(), "low");
        assert_eq!(results[0].id, "b");
    }

    #[test]
    fn empty_query_returns_all_commands_sorted_by_frecency() {
        let commands = vec![command("a", "Alpha"), command("b", "Beta")];
        let mut frecency = HashMap::new();
        frecency.insert("b".to_string(), 5.0);

        let results = search(&commands, "", &frecency, &HashMap::new(), &HashSet::new(), "low");
        assert_eq!(results[0].id, "b");
    }

    #[test]
    fn exact_alias_match_ranks_first_over_a_strong_title_match() {
        let commands = vec![command("dictionary", "Define Word"), command("df-tool", "Disk Free")];
        let mut aliases = HashMap::new();
        aliases.insert("dictionary".to_string(), "df".to_string());

        let results = search(&commands, "df", &HashMap::new(), &aliases, &HashSet::new(), "low");
        assert_eq!(results[0].id, "dictionary");
    }

    #[test]
    fn alias_surfaces_a_command_the_title_alone_would_never_fuzzy_match() {
        // "Word Lookup" has no 'e' or 'f' at all, so a subsequence match on
        // "def" against the title/keywords can never succeed — only the
        // alias text embedded in the haystack can surface it.
        let commands = vec![command("dictionary", "Word Lookup")];
        let mut aliases = HashMap::new();
        aliases.insert("dictionary".to_string(), "define".to_string());

        let results = search(&commands, "def", &HashMap::new(), &aliases, &HashSet::new(), "low");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, "dictionary");
    }

    #[test]
    fn exact_title_match_ranks_above_a_longer_title_containing_it() {
        // "Top Center Sixth" registered before "Center" — reproduces the
        // live bug where the fuzzy matcher scored both haystacks
        // identically for the query "center" and the tie fell to
        // insertion order.
        let commands = vec![command("window.top-center-sixth", "Top Center Sixth"), command("window.center", "Center")];
        let results = search(&commands, "center", &HashMap::new(), &HashMap::new(), &HashSet::new(), "low");
        assert_eq!(results[0].id, "window.center");
    }

    #[test]
    fn disabled_command_is_excluded() {
        let commands = vec![command("firefox", "Firefox")];
        let mut disabled = HashSet::new();
        disabled.insert("firefox".to_string());

        let results = search(&commands, "fire", &HashMap::new(), &HashMap::new(), &disabled, "low");
        assert!(results.is_empty());

        let results = search(&commands, "", &HashMap::new(), &HashMap::new(), &disabled, "low");
        assert!(results.is_empty());
    }

    #[test]
    fn search_sensitivity_drops_weak_scattered_matches_at_medium_and_above() {
        // Reproduces the calibration corpus's junk case: "ai" is a weak,
        // scattered, non-word-boundary subsequence match inside "Create
        // Window Command" (the literal 'a' and 'i' inside cre-A-te
        // w-I-ndow), scoring ~13/char — well under the medium cutoff.
        let commands = vec![command("window.create-command", "Create Window Command")];

        let low = search(&commands, "ai", &HashMap::new(), &HashMap::new(), &HashSet::new(), "low");
        assert_eq!(low.len(), 1, "today's behavior: any subsequence match survives at low sensitivity");

        let medium = search(&commands, "ai", &HashMap::new(), &HashMap::new(), &HashSet::new(), "medium");
        assert!(medium.is_empty(), "a scattered non-word-boundary match should be dropped at medium sensitivity");

        let high = search(&commands, "ai", &HashMap::new(), &HashMap::new(), &HashSet::new(), "high");
        assert!(high.is_empty(), "a scattered non-word-boundary match should also be dropped at high sensitivity");
    }

    #[test]
    fn search_sensitivity_never_drops_a_clean_prefix_match_even_at_high() {
        let commands = vec![command("clipboard-history", "Clipboard History")];

        let high = search(&commands, "clip", &HashMap::new(), &HashMap::new(), &HashSet::new(), "high");
        assert_eq!(high.len(), 1, "a clean prefix match must survive even at high sensitivity");
        assert_eq!(high[0].id, "clipboard-history");
    }

    /// Found live: "ai command" ranked "Create Window Command"/"Search
    /// Window Commands" competitively with — and, with a small frecency
    /// nudge, above — the genuinely relevant AI commands, because every
    /// title/keyword blob here contains the word "command(s)" almost
    /// verbatim (nucleo scores that atom ~192 across the board) while only
    /// the "ai" atom actually discriminates (~62 for a real word-boundary
    /// match vs. ~25 for "ai" scattered inside "cre-A-te w-I-ndow...").
    /// Summing atom scores (nucleo's own `Pattern::score`) buried that
    /// signal in a ~15% gap; `match_list_by_weakest_word`'s minimum-atom
    /// scoring must keep both relevant commands strictly ahead of both
    /// irrelevant ones.
    /// Calibration tool for the `searchSensitivity` cutoff constants (see
    /// `sensitivity_cutoff` below) — not a pass/fail test. Run with
    /// `cargo test --lib application::search::tests::print_sensitivity_calibration_scores -- --ignored --nocapture`
    /// to reproduce the numbers this plan's Phase 2 (T3a) derived them
    /// from: a real corpus of bundled command titles (good = a query a
    /// user would actually type for that command; junk = a technically-
    /// valid but scattered subsequence match nobody wants) scored via
    /// nucleo, normalized by query character length so the cutoff scales
    /// with query length the same way `sensitivity_cutoff` does.
    #[test]
    #[ignore]
    fn print_sensitivity_calibration_scores() {
        let titles = [
            "AI Chat", "AI Providers", "Create AI Command", "Search AI Commands", "Quick AI",
            "Window Management Root Provider", "Create Window Command", "Search Window Commands",
            "Clipboard History", "Screenshots Root Provider", "Switch Windows", "Snippets Root Provider",
            "Create Snippet", "Search Snippets", "Notes", "Create Note", "Search Notes",
            "Translate", "Create Translate Command", "Search Translate Commands",
            "System Commands Root Provider", "Search Emoji & Symbols", "Manage MCP Servers",
            "OpenRay Settings", "Menu Bar Search Root Provider",
        ];
        let commands: Vec<Command> = titles.iter().enumerate().map(|(i, t)| command(&i.to_string(), t)).collect();
        let mut matcher = Matcher::new(Config::DEFAULT);

        // (query, expected-match title, label) — "good" queries a user would
        // plausibly type to reach that command; "junk" queries that only
        // technically subsequence-match a much longer, unrelated title.
        let cases: &[(&str, &str, &str)] = &[
            ("ai chat", "AI Chat", "good: exact words"),
            ("wm", "Window Management Root Provider", "good: word-initial subsequence"),
            ("clip", "Clipboard History", "good: prefix"),
            ("scrn", "Screenshots Root Provider", "good: consonant skeleton"),
            ("snip", "Create Snippet", "good: prefix"),
            ("openray set", "OpenRay Settings", "good: partial words"),
            ("ai", "Create Window Command", "junk: scattered ai in create wIndow"),
            ("ai", "Search Window Commands", "junk: scattered ai in seArch wIndow"),
            ("not", "Menu Bar Search Root Provider", "junk: scattered n-o-t across menu bar root"),
            ("cmd", "Screenshots Root Provider", "junk: scattered c-m-d"),
            ("not", "Notes", "borderline: prefix of a 4-letter title"),
            ("cmd", "Create AI Command", "borderline: consonant skeleton within one word"),
            ("wndw", "Window Management Root Provider", "borderline: consonant skeleton, contiguous-ish"),
        ];

        // Filtering is per-atom (`match_list_by_weakest_word` drops a
        // command the instant *any* atom fails), so the cutoff must be
        // evaluated per-atom against that atom's own char length — not
        // against the pooled minimum score divided by the whole query's
        // length. A pooled metric conflates a short weak atom sitting next
        // to a strong one and understates good multi-word matches.
        for (query, title, label) in cases {
            let pattern = Pattern::parse(query, CaseMatching::Ignore, Normalization::Smart);
            // `Pattern::parse` splits on whitespace into one atom per word
            // (none of this corpus's queries use escaped spaces), so
            // zipping the split query back up with `pattern.atoms` recovers
            // each atom's own char length — `Atom` has no public accessor
            // for it.
            let words: Vec<&str> = query.split_whitespace().collect();
            let haystack = format!("{} ", title);
            let mut buf = Vec::new();
            let utf32 = nucleo_matcher::Utf32Str::new(&haystack, &mut buf);
            let mut worst_per_char: Option<f64> = None;
            let mut any_unmatched = false;
            for (atom, word) in pattern.atoms.iter().zip(words.iter()) {
                let atom_chars = word.chars().count().max(1) as f64;
                match atom.score(utf32, &mut matcher) {
                    Some(score) => {
                        let per_char = score as f64 / atom_chars;
                        worst_per_char = Some(worst_per_char.map_or(per_char, |w: f64| w.min(per_char)));
                    }
                    None => any_unmatched = true,
                }
            }
            match (any_unmatched, worst_per_char) {
                (true, _) => println!("{label:55} query={query:12?} title={title:35?} NO MATCH"),
                (false, Some(worst)) => println!("{label:55} query={query:12?} title={title:35?} worst_atom_per_char={worst:.2}"),
                (false, None) => println!("{label:55} query={query:12?} title={title:35?} (empty pattern)"),
            }
        }
        let _ = commands.len();
    }

    #[test]
    fn multi_word_query_is_scored_by_its_weakest_matching_word_not_the_sum() {
        let commands = vec![
            command_with_keywords("ext:ai:search-ai-commands", "Search AI Commands", &["ai", "commands"]),
            command_with_keywords("ext:ai:create-ai-command", "Create AI Command", &["ai", "command", "create"]),
            command_with_keywords("ext:window-management:create-window-command", "Create Window Command", &["window", "custom", "layout"]),
            command_with_keywords(
                "ext:window-management:search-window-commands",
                "Search Window Commands",
                &["window", "custom", "layout", "search"],
            ),
        ];

        let results = search(&commands, "ai command", &HashMap::new(), &HashMap::new(), &HashSet::new(), "low");

        let rank = |id: &str| results.iter().position(|c| c.id == id).unwrap();
        assert!(
            rank("ext:ai:search-ai-commands") < rank("ext:window-management:create-window-command"),
            "a relevant AI command must outrank an irrelevant window command"
        );
        assert!(
            rank("ext:ai:create-ai-command") < rank("ext:window-management:search-window-commands"),
            "a relevant AI command must outrank an irrelevant window command"
        );
    }

}
