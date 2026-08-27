-- T26: migrate existing notes into extension_storage under the "notes"
-- extension id, so root search/the Notes extension read them instead of
-- the native NotesProvider (deleted this same task).
--
-- Keyed by 'note:' || sync_id -- NOT the local integer `id` every other
-- migration in this series (0021-0024) used. sync_id (added in
-- 0018_sync.sql specifically because the integer id collides across
-- devices and can't be rewritten) is what preserves cross-device merge
-- continuity: application::sync::snapshot's notes export/import already
-- keys exclusively on sync_id, never the local id, so this migration must
-- use the same key or a note that already synced to another device would
-- appear as a brand-new, duplicate note once the extension version pushes
-- its own snapshot.
--
-- sync_id is NOT guaranteed populated at this point, and this matters more
-- here than it did for translate_history's own migration: 0018_sync.sql's
-- own doc comment says new rows get their sync_id "assigned lazily by the
-- sync engine before each export... not at insert time" -- so any note
-- created after 0018 shipped but before the sync engine's first real
-- export (or created by a user who has never configured Cloud Sync at all)
-- still has sync_id IS NULL right now. Backfilling here -- the same
-- lower(hex(randomblob(16))) expression 0018_sync.sql itself used for its
-- own initial backfill -- guarantees every note gets a real
-- extension_storage row regardless of whether sync has ever run, and is a
-- strict improvement for sync too: every note now has a stable id
-- immediately instead of waiting on a lazy assignment a never-synced user
-- would otherwise wait on forever.
UPDATE notes SET sync_id = lower(hex(randomblob(16))) WHERE sync_id IS NULL;

-- notes is deliberately left in place for one release -- same dual-write
-- rationale as every prior wave (see SNAPSHOT_VERSION's doc comment in
-- application/sync/snapshot.rs). application::sync keeps reading/writing
-- the native table directly regardless, unaffected by this migration or by
-- T26's native-code deletion -- see that module's own doc comment.
INSERT OR IGNORE INTO extension_storage (extension_id, key, value)
SELECT
  'notes',
  'note:' || sync_id,
  json_quote(printf('%s', json_object(
    'id', sync_id,
    'content', content,
    'pinnedAt', pinned_at,
    'createdAt', created_at,
    'updatedAt', updated_at,
    'lastOpenedAt', last_opened_at
  )))
FROM notes;
