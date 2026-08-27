CREATE TABLE IF NOT EXISTS command_settings (
    command_id TEXT PRIMARY KEY,
    alias TEXT,
    hotkey TEXT,
    enabled INTEGER NOT NULL DEFAULT 1
);
