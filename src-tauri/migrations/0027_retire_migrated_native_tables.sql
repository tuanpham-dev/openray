-- T31: retire the six native tables T15/T16/T18/T22/T26 already migrated
-- into extension_storage (0021-0025), each frozen at its own migration
-- time since no application code has written to them since (only Cloud
-- Sync's own dual-write export/apply, removed this same wave — see
-- application/sync/snapshot.rs, which no longer knows any of these six
-- kinds and bumped SNAPSHOT_VERSION to document the wire-format change).
--
-- DROP TABLE cascades to a table's own indexes and triggers automatically
-- (SQLite drops them silently along with the table), so the
-- sync_meta_{notes,snippets,quicklinks,window_commands,translate_commands,
-- translate_history}_{ai,au,ad} triggers and notes/translate_history's
-- sync_id unique indexes (0018_sync.sql) don't need separate DROP
-- statements here.
--
-- Their sync_meta rows are deleted too — a lingering row under a kind
-- nothing exports anymore is just noise, and this is a genuine DELETE
-- (not a tombstone insert): there's no longer a live kind for a remote
-- to compare it against.
DELETE FROM sync_meta WHERE kind IN ('notes', 'snippets', 'quicklinks', 'window_commands', 'translate_commands', 'translate_history');

DROP TABLE IF EXISTS notes;
DROP TABLE IF EXISTS snippets;
DROP TABLE IF EXISTS quicklinks;
DROP TABLE IF EXISTS window_commands;
DROP TABLE IF EXISTS translate_commands;
DROP TABLE IF EXISTS translate_history;
