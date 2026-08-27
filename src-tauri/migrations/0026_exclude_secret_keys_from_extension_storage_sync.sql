-- T27: `extension_storage` keys prefixed `secret:` (the AI extension's
-- provider API keys, MCP OAuth tokens, MCP client secrets — see
-- `extensions/ai/src/storage.ts`'s doc comment) must never leave the
-- device via Cloud Sync, unlike every other extension_storage key, which
-- syncs wholesale (`application::sync::snapshot::export`'s own doc
-- comment: no prior "excluded key" concept existed anywhere in this
-- codebase before this). The 0018 triggers below stamp `sync_meta` for
-- *every* write unconditionally; recreated here with a `WHEN` guard so a
-- secret-prefixed key never gets a `sync_meta` row at all — `export_kind`
-- (snapshot.rs) only ever sees ids that exist in `sync_meta`, so this is
-- sufficient on its own, no Rust-side filtering needed.
DROP TRIGGER IF EXISTS sync_meta_extension_storage_ai;
DROP TRIGGER IF EXISTS sync_meta_extension_storage_au;
DROP TRIGGER IF EXISTS sync_meta_extension_storage_ad;

CREATE TRIGGER sync_meta_extension_storage_ai AFTER INSERT ON extension_storage WHEN NEW.key NOT LIKE 'secret:%' BEGIN
    INSERT INTO sync_meta (kind, id, updated_at, deleted) VALUES ('extension_storage', NEW.extension_id || ':' || NEW.key, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), 0)
    ON CONFLICT(kind, id) DO UPDATE SET updated_at = excluded.updated_at, deleted = 0;
END;
CREATE TRIGGER sync_meta_extension_storage_au AFTER UPDATE ON extension_storage WHEN NEW.key NOT LIKE 'secret:%' BEGIN
    INSERT INTO sync_meta (kind, id, updated_at, deleted) VALUES ('extension_storage', NEW.extension_id || ':' || NEW.key, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), 0)
    ON CONFLICT(kind, id) DO UPDATE SET updated_at = excluded.updated_at, deleted = 0;
END;
CREATE TRIGGER sync_meta_extension_storage_ad AFTER DELETE ON extension_storage WHEN OLD.key NOT LIKE 'secret:%' BEGIN
    INSERT INTO sync_meta (kind, id, updated_at, deleted) VALUES ('extension_storage', OLD.extension_id || ':' || OLD.key, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), 1)
    ON CONFLICT(kind, id) DO UPDATE SET updated_at = excluded.updated_at, deleted = 1;
END;

-- Defensive cleanup: any secret-prefixed key that already picked up a
-- sync_meta row before this migration (none should exist pre-T27, but a
-- dev/test cycle could have written one) must not linger and get synced
-- on the next export.
DELETE FROM sync_meta WHERE kind = 'extension_storage' AND id LIKE '%:secret:%';
