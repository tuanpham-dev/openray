-- Cloud Sync foundations: change-tracking for every synced table via a
-- single sync_meta table kept current by triggers, so no existing write
-- path needs editing.
--
-- notes and translate_history use an INTEGER AUTOINCREMENT primary key,
-- which collides across machines (two devices both mint id=1) and can't be
-- rewritten to a TEXT PK here: both are shipped, tested features with the
-- integer id threaded through application code (notes' active_note_id
-- state and notes.item.<id> command routing). Instead they get a bolt-on
-- nullable sync_id column, backfilled for existing rows below. New rows
-- get their sync_id assigned lazily by the sync engine before each export
-- (see application/sync/snapshot.rs), not here and not at insert time —
-- SQLite rejects a non-constant ADD COLUMN default once a table has
-- existing rows ("Cannot add a column with non-constant default"),
-- verified directly against this sqlite3 build, so the id can't just be a
-- DEFAULT (randomblob(...)) clause on the ALTER TABLE itself.

ALTER TABLE notes ADD COLUMN sync_id TEXT;
UPDATE notes SET sync_id = lower(hex(randomblob(16))) WHERE sync_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_sync_id ON notes (sync_id);

ALTER TABLE translate_history ADD COLUMN sync_id TEXT;
UPDATE translate_history SET sync_id = lower(hex(randomblob(16))) WHERE sync_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_translate_history_sync_id ON translate_history (sync_id);

-- One row per synced record: when it last changed (unix milliseconds) and
-- whether that change was a delete (tombstone). kind + id together identify
-- the record; composite-PK tables (extension_preference_values,
-- extension_storage) join their PK columns with ':' for id. notes and
-- translate_history use their sync_id (never their local integer id).
CREATE TABLE IF NOT EXISTS sync_meta (
    kind TEXT NOT NULL,
    id TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (kind, id)
);

-- notes (guarded: a row's sync_id is NULL until the lazy backfill runs, so
-- INSERT can't stamp sync_meta yet — the AFTER UPDATE trigger picks it up
-- the moment the backfill UPDATE sets sync_id, same as any later edit)
CREATE TRIGGER IF NOT EXISTS sync_meta_notes_au AFTER UPDATE ON notes WHEN NEW.sync_id IS NOT NULL BEGIN
    INSERT INTO sync_meta (kind, id, updated_at, deleted) VALUES ('notes', NEW.sync_id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), 0)
    ON CONFLICT(kind, id) DO UPDATE SET updated_at = excluded.updated_at, deleted = 0;
END;
CREATE TRIGGER IF NOT EXISTS sync_meta_notes_ad AFTER DELETE ON notes WHEN OLD.sync_id IS NOT NULL BEGIN
    INSERT INTO sync_meta (kind, id, updated_at, deleted) VALUES ('notes', OLD.sync_id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), 1)
    ON CONFLICT(kind, id) DO UPDATE SET updated_at = excluded.updated_at, deleted = 1;
END;

-- snippets
CREATE TRIGGER IF NOT EXISTS sync_meta_snippets_ai AFTER INSERT ON snippets BEGIN
    INSERT INTO sync_meta (kind, id, updated_at, deleted) VALUES ('snippets', NEW.id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), 0)
    ON CONFLICT(kind, id) DO UPDATE SET updated_at = excluded.updated_at, deleted = 0;
END;
CREATE TRIGGER IF NOT EXISTS sync_meta_snippets_au AFTER UPDATE ON snippets BEGIN
    INSERT INTO sync_meta (kind, id, updated_at, deleted) VALUES ('snippets', NEW.id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), 0)
    ON CONFLICT(kind, id) DO UPDATE SET updated_at = excluded.updated_at, deleted = 0;
END;
CREATE TRIGGER IF NOT EXISTS sync_meta_snippets_ad AFTER DELETE ON snippets BEGIN
    INSERT INTO sync_meta (kind, id, updated_at, deleted) VALUES ('snippets', OLD.id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), 1)
    ON CONFLICT(kind, id) DO UPDATE SET updated_at = excluded.updated_at, deleted = 1;
END;

-- quicklinks
CREATE TRIGGER IF NOT EXISTS sync_meta_quicklinks_ai AFTER INSERT ON quicklinks BEGIN
    INSERT INTO sync_meta (kind, id, updated_at, deleted) VALUES ('quicklinks', NEW.id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), 0)
    ON CONFLICT(kind, id) DO UPDATE SET updated_at = excluded.updated_at, deleted = 0;
END;
CREATE TRIGGER IF NOT EXISTS sync_meta_quicklinks_au AFTER UPDATE ON quicklinks BEGIN
    INSERT INTO sync_meta (kind, id, updated_at, deleted) VALUES ('quicklinks', NEW.id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), 0)
    ON CONFLICT(kind, id) DO UPDATE SET updated_at = excluded.updated_at, deleted = 0;
END;
CREATE TRIGGER IF NOT EXISTS sync_meta_quicklinks_ad AFTER DELETE ON quicklinks BEGIN
    INSERT INTO sync_meta (kind, id, updated_at, deleted) VALUES ('quicklinks', OLD.id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), 1)
    ON CONFLICT(kind, id) DO UPDATE SET updated_at = excluded.updated_at, deleted = 1;
END;

-- window_commands
CREATE TRIGGER IF NOT EXISTS sync_meta_window_commands_ai AFTER INSERT ON window_commands BEGIN
    INSERT INTO sync_meta (kind, id, updated_at, deleted) VALUES ('window_commands', NEW.id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), 0)
    ON CONFLICT(kind, id) DO UPDATE SET updated_at = excluded.updated_at, deleted = 0;
END;
CREATE TRIGGER IF NOT EXISTS sync_meta_window_commands_au AFTER UPDATE ON window_commands BEGIN
    INSERT INTO sync_meta (kind, id, updated_at, deleted) VALUES ('window_commands', NEW.id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), 0)
    ON CONFLICT(kind, id) DO UPDATE SET updated_at = excluded.updated_at, deleted = 0;
END;
CREATE TRIGGER IF NOT EXISTS sync_meta_window_commands_ad AFTER DELETE ON window_commands BEGIN
    INSERT INTO sync_meta (kind, id, updated_at, deleted) VALUES ('window_commands', OLD.id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), 1)
    ON CONFLICT(kind, id) DO UPDATE SET updated_at = excluded.updated_at, deleted = 1;
END;

-- translate_commands
CREATE TRIGGER IF NOT EXISTS sync_meta_translate_commands_ai AFTER INSERT ON translate_commands BEGIN
    INSERT INTO sync_meta (kind, id, updated_at, deleted) VALUES ('translate_commands', NEW.id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), 0)
    ON CONFLICT(kind, id) DO UPDATE SET updated_at = excluded.updated_at, deleted = 0;
END;
CREATE TRIGGER IF NOT EXISTS sync_meta_translate_commands_au AFTER UPDATE ON translate_commands BEGIN
    INSERT INTO sync_meta (kind, id, updated_at, deleted) VALUES ('translate_commands', NEW.id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), 0)
    ON CONFLICT(kind, id) DO UPDATE SET updated_at = excluded.updated_at, deleted = 0;
END;
CREATE TRIGGER IF NOT EXISTS sync_meta_translate_commands_ad AFTER DELETE ON translate_commands BEGIN
    INSERT INTO sync_meta (kind, id, updated_at, deleted) VALUES ('translate_commands', OLD.id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), 1)
    ON CONFLICT(kind, id) DO UPDATE SET updated_at = excluded.updated_at, deleted = 1;
END;

-- translate_history (guarded, same reasoning as notes above)
CREATE TRIGGER IF NOT EXISTS sync_meta_translate_history_au AFTER UPDATE ON translate_history WHEN NEW.sync_id IS NOT NULL BEGIN
    INSERT INTO sync_meta (kind, id, updated_at, deleted) VALUES ('translate_history', NEW.sync_id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), 0)
    ON CONFLICT(kind, id) DO UPDATE SET updated_at = excluded.updated_at, deleted = 0;
END;
CREATE TRIGGER IF NOT EXISTS sync_meta_translate_history_ad AFTER DELETE ON translate_history WHEN OLD.sync_id IS NOT NULL BEGIN
    INSERT INTO sync_meta (kind, id, updated_at, deleted) VALUES ('translate_history', OLD.sync_id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), 1)
    ON CONFLICT(kind, id) DO UPDATE SET updated_at = excluded.updated_at, deleted = 1;
END;

-- command_settings (PK = command_id)
CREATE TRIGGER IF NOT EXISTS sync_meta_command_settings_ai AFTER INSERT ON command_settings BEGIN
    INSERT INTO sync_meta (kind, id, updated_at, deleted) VALUES ('command_settings', NEW.command_id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), 0)
    ON CONFLICT(kind, id) DO UPDATE SET updated_at = excluded.updated_at, deleted = 0;
END;
CREATE TRIGGER IF NOT EXISTS sync_meta_command_settings_au AFTER UPDATE ON command_settings BEGIN
    INSERT INTO sync_meta (kind, id, updated_at, deleted) VALUES ('command_settings', NEW.command_id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), 0)
    ON CONFLICT(kind, id) DO UPDATE SET updated_at = excluded.updated_at, deleted = 0;
END;
CREATE TRIGGER IF NOT EXISTS sync_meta_command_settings_ad AFTER DELETE ON command_settings BEGIN
    INSERT INTO sync_meta (kind, id, updated_at, deleted) VALUES ('command_settings', OLD.command_id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), 1)
    ON CONFLICT(kind, id) DO UPDATE SET updated_at = excluded.updated_at, deleted = 1;
END;

-- clipboard_history (clipboard sync toggle)
CREATE TRIGGER IF NOT EXISTS sync_meta_clipboard_history_ai AFTER INSERT ON clipboard_history BEGIN
    INSERT INTO sync_meta (kind, id, updated_at, deleted) VALUES ('clipboard_history', NEW.id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), 0)
    ON CONFLICT(kind, id) DO UPDATE SET updated_at = excluded.updated_at, deleted = 0;
END;
CREATE TRIGGER IF NOT EXISTS sync_meta_clipboard_history_ad AFTER DELETE ON clipboard_history BEGIN
    INSERT INTO sync_meta (kind, id, updated_at, deleted) VALUES ('clipboard_history', OLD.id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), 1)
    ON CONFLICT(kind, id) DO UPDATE SET updated_at = excluded.updated_at, deleted = 1;
END;

-- extension_preference_values (PK = extension_id, name; likely secrets, extensions sync toggle)
CREATE TRIGGER IF NOT EXISTS sync_meta_extension_preference_values_ai AFTER INSERT ON extension_preference_values BEGIN
    INSERT INTO sync_meta (kind, id, updated_at, deleted) VALUES ('extension_preference_values', NEW.extension_id || ':' || NEW.name, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), 0)
    ON CONFLICT(kind, id) DO UPDATE SET updated_at = excluded.updated_at, deleted = 0;
END;
CREATE TRIGGER IF NOT EXISTS sync_meta_extension_preference_values_au AFTER UPDATE ON extension_preference_values BEGIN
    INSERT INTO sync_meta (kind, id, updated_at, deleted) VALUES ('extension_preference_values', NEW.extension_id || ':' || NEW.name, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), 0)
    ON CONFLICT(kind, id) DO UPDATE SET updated_at = excluded.updated_at, deleted = 0;
END;
CREATE TRIGGER IF NOT EXISTS sync_meta_extension_preference_values_ad AFTER DELETE ON extension_preference_values BEGIN
    INSERT INTO sync_meta (kind, id, updated_at, deleted) VALUES ('extension_preference_values', OLD.extension_id || ':' || OLD.name, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), 1)
    ON CONFLICT(kind, id) DO UPDATE SET updated_at = excluded.updated_at, deleted = 1;
END;

-- extension_storage (PK = extension_id, key; extensions sync toggle)
CREATE TRIGGER IF NOT EXISTS sync_meta_extension_storage_ai AFTER INSERT ON extension_storage BEGIN
    INSERT INTO sync_meta (kind, id, updated_at, deleted) VALUES ('extension_storage', NEW.extension_id || ':' || NEW.key, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), 0)
    ON CONFLICT(kind, id) DO UPDATE SET updated_at = excluded.updated_at, deleted = 0;
END;
CREATE TRIGGER IF NOT EXISTS sync_meta_extension_storage_au AFTER UPDATE ON extension_storage BEGIN
    INSERT INTO sync_meta (kind, id, updated_at, deleted) VALUES ('extension_storage', NEW.extension_id || ':' || NEW.key, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), 0)
    ON CONFLICT(kind, id) DO UPDATE SET updated_at = excluded.updated_at, deleted = 0;
END;
CREATE TRIGGER IF NOT EXISTS sync_meta_extension_storage_ad AFTER DELETE ON extension_storage BEGIN
    INSERT INTO sync_meta (kind, id, updated_at, deleted) VALUES ('extension_storage', OLD.extension_id || ':' || OLD.key, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), 1)
    ON CONFLICT(kind, id) DO UPDATE SET updated_at = excluded.updated_at, deleted = 1;
END;

-- usage (PK = command_id; merged by max(hits)/max(last_used_at) at apply time, not LWW)
CREATE TRIGGER IF NOT EXISTS sync_meta_usage_ai AFTER INSERT ON usage BEGIN
    INSERT INTO sync_meta (kind, id, updated_at, deleted) VALUES ('usage', NEW.command_id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), 0)
    ON CONFLICT(kind, id) DO UPDATE SET updated_at = excluded.updated_at, deleted = 0;
END;
CREATE TRIGGER IF NOT EXISTS sync_meta_usage_au AFTER UPDATE ON usage BEGIN
    INSERT INTO sync_meta (kind, id, updated_at, deleted) VALUES ('usage', NEW.command_id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), 0)
    ON CONFLICT(kind, id) DO UPDATE SET updated_at = excluded.updated_at, deleted = 0;
END;

-- Backfill: a trigger only fires for future DML, never retroactively, so
-- every row that already existed before the triggers above were created
-- needs a one-time manual sync_meta row here — otherwise an upgrading
-- user's existing snippets/quicklinks/notes/etc. would be invisible to
-- their very first sync push until each one is individually edited or
-- deleted. ON CONFLICT DO NOTHING makes each INSERT idempotent (harmless
-- if a row was already stamped, e.g. notes/translate_history rows whose
-- sync_id backfill UPDATE above already fired their AFTER UPDATE
-- trigger). Tables with no per-row timestamp column of their own
-- (command_settings, extension_preference_values, extension_storage) use
-- this migration's own apply time as their baseline instead.
INSERT OR IGNORE INTO sync_meta (kind, id, updated_at, deleted)
SELECT 'notes', sync_id, updated_at * 1000, 0 FROM notes WHERE sync_id IS NOT NULL;

INSERT OR IGNORE INTO sync_meta (kind, id, updated_at, deleted)
SELECT 'snippets', id, created_at * 1000, 0 FROM snippets;

INSERT OR IGNORE INTO sync_meta (kind, id, updated_at, deleted)
SELECT 'quicklinks', id, created_at * 1000, 0 FROM quicklinks;

INSERT OR IGNORE INTO sync_meta (kind, id, updated_at, deleted)
SELECT 'window_commands', id, created_at * 1000, 0 FROM window_commands;

INSERT OR IGNORE INTO sync_meta (kind, id, updated_at, deleted)
SELECT 'translate_commands', id, created_at * 1000, 0 FROM translate_commands;

INSERT OR IGNORE INTO sync_meta (kind, id, updated_at, deleted)
SELECT 'translate_history', sync_id, created_at * 1000, 0 FROM translate_history WHERE sync_id IS NOT NULL;

INSERT OR IGNORE INTO sync_meta (kind, id, updated_at, deleted)
SELECT 'command_settings', command_id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), 0 FROM command_settings;

INSERT OR IGNORE INTO sync_meta (kind, id, updated_at, deleted)
SELECT 'clipboard_history', id, created_at * 1000, 0 FROM clipboard_history;

INSERT OR IGNORE INTO sync_meta (kind, id, updated_at, deleted)
SELECT 'extension_preference_values', extension_id || ':' || name, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), 0 FROM extension_preference_values;

INSERT OR IGNORE INTO sync_meta (kind, id, updated_at, deleted)
SELECT 'extension_storage', extension_id || ':' || key, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), 0 FROM extension_storage;

INSERT OR IGNORE INTO sync_meta (kind, id, updated_at, deleted)
SELECT 'usage', command_id, last_used_at * 1000, 0 FROM usage;
