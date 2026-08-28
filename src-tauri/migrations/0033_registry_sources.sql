-- Registries an extension can be installed from: a base URL (or local
-- directory) serving `index.json` plus one archive per extension. Multiple
-- sources are the point — OpenRay runs no backend, so "the store" is
-- whichever catalogs a user has chosen to trust.
--
-- `auto_update` is per-source because trust is per-source: updates are
-- unsigned remote code applied without user action, so a user who wants
-- that for the default registry but not for a colleague's can say so.
CREATE TABLE IF NOT EXISTS registry_sources (
    url TEXT PRIMARY KEY,
    name TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    auto_update INTEGER NOT NULL DEFAULT 1,
    added_at INTEGER NOT NULL
);
