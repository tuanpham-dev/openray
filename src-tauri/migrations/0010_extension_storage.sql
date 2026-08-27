-- LocalStorage for extensions, namespaced per extension so one cannot read
-- another's data. Values are JSON-encoded strings so string/number/boolean
-- round-trip with their types intact.
CREATE TABLE IF NOT EXISTS extension_storage (
    extension_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (extension_id, key)
);
