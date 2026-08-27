use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use crate::domain::command::Command;
use crate::domain::ports::CommandProvider;

/// One provider's cached `commands()` output plus the generation it was
/// fetched at. `populated: false` (only true before the very first
/// `refresh()`) forces an initial fetch regardless of what `generation()`
/// returns, so a provider whose first-ever generation happens to be
/// `Some(0)` isn't mistaken for "already cached."
#[derive(Default)]
struct CacheEntry {
    last_generation: Option<u64>,
    commands: Vec<Command>,
    populated: bool,
}

/// Providers are held as `Arc<dyn CommandProvider>` (not `Box`) so the
/// same instance registered here can also be shared into `AppState` for
/// providers that need direct access outside the registry (e.g.
/// `state.notes.get_active_note()`) — a `Box` would force a second,
/// independent construction, which previously caused real state
/// divergence: `NotesProvider`'s `active_note_id` mutex, for one, existed
/// as two separate instances that never saw each other's writes.
///
/// `commands()` is cached per provider (see [`CommandProvider::generation`])
/// and an id→provider index is maintained alongside it, so a search
/// keystroke or a command launch no longer re-queries every SQLite-backed
/// provider on every call — only providers whose `generation()` actually
/// changed since the last check get their `commands()` re-fetched. A
/// provider that doesn't opt into generation tracking (the default,
/// `None`) is always treated as changed, matching its pre-caching
/// behavior exactly — this is what keeps the cache correctness-safe by
/// construction: opting out can never serve stale data, only opting in
/// (and forgetting to bump the counter after a write) can, and that's a
/// property of the provider, not the registry.
#[derive(Default)]
pub struct CommandRegistry {
    providers: Vec<Arc<dyn CommandProvider>>,
    cache: RwLock<Vec<CacheEntry>>,
    /// Command id → index into `providers`/`cache`. Rebuilt whenever
    /// `refresh()` finds any provider stale, so `execute`/
    /// `execute_with_argument` are an O(1) hash lookup instead of an
    /// O(providers) scan that calls `commands()` (and thus hits SQLite)
    /// on every provider in turn until one matches.
    id_index: RwLock<HashMap<String, usize>>,
}

impl CommandRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, provider: Arc<dyn CommandProvider>) {
        self.providers.push(provider);
        // `&mut self` here (setup-time only, before the registry is
        // shared) means the cache list needs no lock to grow in lockstep.
        self.cache.get_mut().unwrap().push(CacheEntry::default());
    }

    /// Re-fetches `commands()` for every provider whose cache is stale
    /// (never populated, or `generation()` changed since the last
    /// refresh — always true for a provider that returns `None`) and
    /// rebuilds the id index if anything changed. Idempotent and cheap
    /// to call on every access: for a provider whose generation is
    /// unchanged, the "is it stale" check is a single method call
    /// returning an already-loaded value, not a SQLite query.
    fn refresh(&self) {
        let mut cache = self.cache.write().unwrap();
        let mut any_changed = false;
        for (i, provider) in self.providers.iter().enumerate() {
            let current_generation = provider.generation();
            let entry = &mut cache[i];
            let stale = !entry.populated || current_generation.is_none() || current_generation != entry.last_generation;
            if stale {
                entry.commands = provider.commands();
                entry.last_generation = current_generation;
                entry.populated = true;
                any_changed = true;
            }
        }
        if any_changed {
            // Earliest-registered provider wins on an id collision —
            // matches the original linear scan's first-match semantics,
            // for the hypothetical case two providers ever contribute
            // the same id.
            let mut index = HashMap::new();
            for (i, entry) in cache.iter().enumerate() {
                for command in &entry.commands {
                    index.entry(command.id.clone()).or_insert(i);
                }
            }
            drop(cache);
            *self.id_index.write().unwrap() = index;
        }
    }

    pub fn all_commands(&self) -> Vec<Command> {
        self.refresh();
        self.cache.read().unwrap().iter().flat_map(|entry| entry.commands.iter().cloned()).collect()
    }

    pub fn execute(&self, command_id: &str) -> Result<(), String> {
        self.refresh();
        let owner = self.id_index.read().unwrap().get(command_id).copied();
        match owner {
            Some(i) => self.providers[i].execute(command_id),
            None => Err(format!("no provider found for command '{command_id}'")),
        }
    }

    pub fn execute_with_argument(&self, command_id: &str, argument: &str) -> Result<(), String> {
        self.refresh();
        let owner = self.id_index.read().unwrap().get(command_id).copied();
        match owner {
            Some(i) => self.providers[i].execute_with_argument(command_id, argument),
            None => Err(format!("no provider found for command '{command_id}'")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::command::CommandKind;

    struct FakeProvider {
        commands: Vec<Command>,
    }

    impl CommandProvider for FakeProvider {
        fn commands(&self) -> Vec<Command> {
            self.commands.clone()
        }

        fn execute(&self, _command_id: &str) -> Result<(), String> {
            Ok(())
        }
    }

    #[test]
    fn lists_registered_provider_commands() {
        let mut registry = CommandRegistry::new();
        registry.register(Arc::new(FakeProvider {
            commands: vec![Command {
                id: "fake.command".into(),
                title: "Fake Command".into(),
                subtitle: None,
                icon: None,
                kind: CommandKind::Builtin,
                keywords: vec![],
                requires_argument: false,
            }],
        }));

        let commands = registry.all_commands();
        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0].id, "fake.command");
    }

    #[test]
    fn aggregates_across_multiple_providers() {
        let mut registry = CommandRegistry::new();
        registry.register(Arc::new(FakeProvider {
            commands: vec![Command {
                id: "a".into(),
                title: "A".into(),
                subtitle: None,
                icon: None,
                kind: CommandKind::Builtin,
                keywords: vec![],
                requires_argument: false,
            }],
        }));
        registry.register(Arc::new(FakeProvider {
            commands: vec![Command {
                id: "b".into(),
                title: "B".into(),
                subtitle: None,
                icon: None,
                kind: CommandKind::App,
                keywords: vec![],
                requires_argument: false,
            }],
        }));

        assert_eq!(registry.all_commands().len(), 2);
    }

    /// Regression test for a real bug: before providers were held as
    /// `Arc<dyn CommandProvider>`, `lib.rs` constructed each stateful
    /// provider *twice* — once registered into `CommandRegistry`, once
    /// stored directly on `AppState` — so the two never shared interior
    /// state. `NotesProvider.active_note_id` was the concrete casualty:
    /// opening a note through the palette (which goes through
    /// `CommandRegistry::execute`) stamped the registry's private copy,
    /// while `api::notes::get_active_note` read `AppState`'s separate
    /// copy and always saw `None`. This proves the fix at the mechanism
    /// level — a fake provider with the same "mutable state behind
    /// `&self`" shape `NotesProvider` has — without needing a live
    /// `AppHandle`/window subsystem the real provider's `execute` calls
    /// into.
    struct StatefulProvider {
        opened_id: std::sync::Mutex<Option<i64>>,
    }

    impl CommandProvider for StatefulProvider {
        fn commands(&self) -> Vec<Command> {
            vec![Command {
                id: "notes.item.1".into(),
                title: "A Note".into(),
                subtitle: None,
                icon: None,
                kind: CommandKind::Builtin,
                keywords: vec![],
                requires_argument: false,
            }]
        }

        fn execute(&self, command_id: &str) -> Result<(), String> {
            let id: i64 = command_id.strip_prefix("notes.item.").unwrap().parse().unwrap();
            *self.opened_id.lock().unwrap() = Some(id);
            Ok(())
        }
    }

    #[test]
    fn a_provider_executed_through_the_registry_is_the_same_instance_a_caller_holds_directly() {
        let provider = Arc::new(StatefulProvider { opened_id: std::sync::Mutex::new(None) });
        // Mirrors lib.rs: the same Arc registered into CommandRegistry is
        // also kept aside, standing in for AppState's copy.
        let app_state_handle = provider.clone();

        let mut registry = CommandRegistry::new();
        registry.register(provider.clone() as Arc<dyn CommandProvider>);

        assert_eq!(*app_state_handle.opened_id.lock().unwrap(), None);
        registry.execute("notes.item.1").unwrap();
        assert_eq!(
            *app_state_handle.opened_id.lock().unwrap(),
            Some(1),
            "the registry's execute() must mutate the same instance the AppState-side handle observes"
        );
    }

    /// A provider that counts every `commands()` call and only reports a
    /// changed `generation()` when the test explicitly bumps it —
    /// standing in for a SQLite-backed provider that bumps its counter
    /// after a real write.
    struct CountingCacheableProvider {
        call_count: std::sync::atomic::AtomicU64,
        generation: std::sync::atomic::AtomicU64,
        command_id: String,
    }

    impl CommandProvider for CountingCacheableProvider {
        fn commands(&self) -> Vec<Command> {
            self.call_count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            vec![Command {
                id: self.command_id.clone(),
                title: "Cacheable".into(),
                subtitle: None,
                icon: None,
                kind: CommandKind::Builtin,
                keywords: vec![],
                requires_argument: false,
            }]
        }

        fn execute(&self, _command_id: &str) -> Result<(), String> {
            Ok(())
        }

        fn generation(&self) -> Option<u64> {
            Some(self.generation.load(std::sync::atomic::Ordering::SeqCst))
        }
    }

    #[test]
    fn a_cacheable_providers_commands_are_fetched_once_then_reused_across_many_calls() {
        let provider = Arc::new(CountingCacheableProvider {
            call_count: std::sync::atomic::AtomicU64::new(0),
            generation: std::sync::atomic::AtomicU64::new(0),
            command_id: "cached.command".into(),
        });
        let mut registry = CommandRegistry::new();
        registry.register(provider.clone() as Arc<dyn CommandProvider>);

        // Five separate accesses — mirroring five search keystrokes plus
        // a launch — must fetch `commands()` exactly once.
        for _ in 0..3 {
            registry.all_commands();
        }
        registry.execute("cached.command").unwrap();
        registry.execute_with_argument("cached.command", "arg").unwrap();

        assert_eq!(
            provider.call_count.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "an unchanged cacheable provider must be fetched exactly once, not once per access"
        );
    }

    #[test]
    fn bumping_a_cacheable_providers_generation_forces_exactly_one_refetch() {
        let provider = Arc::new(CountingCacheableProvider {
            call_count: std::sync::atomic::AtomicU64::new(0),
            generation: std::sync::atomic::AtomicU64::new(0),
            command_id: "cached.command".into(),
        });
        let mut registry = CommandRegistry::new();
        registry.register(provider.clone() as Arc<dyn CommandProvider>);

        registry.all_commands();
        registry.all_commands();
        assert_eq!(provider.call_count.load(std::sync::atomic::Ordering::SeqCst), 1);

        // Simulates the provider's own write path bumping its counter.
        provider.generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst);

        registry.all_commands();
        registry.all_commands();
        assert_eq!(
            provider.call_count.load(std::sync::atomic::Ordering::SeqCst),
            2,
            "a generation bump must force exactly one refetch, then cache again"
        );
    }

    #[test]
    fn a_provider_that_does_not_opt_into_caching_is_refetched_every_access() {
        // Regression guard: the default `generation() -> None` must keep
        // matching pre-caching behavior exactly — always refetch, never
        // silently start caching a provider that never asked for it.
        struct AlwaysUncached {
            call_count: std::sync::atomic::AtomicU64,
        }
        impl CommandProvider for AlwaysUncached {
            fn commands(&self) -> Vec<Command> {
                self.call_count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                vec![]
            }
            fn execute(&self, _command_id: &str) -> Result<(), String> {
                Ok(())
            }
        }

        let provider = Arc::new(AlwaysUncached { call_count: std::sync::atomic::AtomicU64::new(0) });
        let mut registry = CommandRegistry::new();
        registry.register(provider.clone() as Arc<dyn CommandProvider>);

        registry.all_commands();
        registry.all_commands();
        registry.all_commands();

        assert_eq!(provider.call_count.load(std::sync::atomic::Ordering::SeqCst), 3);
    }

    #[test]
    fn execute_dispatches_to_the_owning_provider() {
        let mut registry = CommandRegistry::new();
        registry.register(Arc::new(FakeProvider {
            commands: vec![Command {
                id: "known".into(),
                title: "Known".into(),
                subtitle: None,
                icon: None,
                kind: CommandKind::Builtin,
                keywords: vec![],
                requires_argument: false,
            }],
        }));

        assert!(registry.execute("known").is_ok());
        assert!(registry.execute("missing").is_err());
    }
}
