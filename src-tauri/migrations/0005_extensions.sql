CREATE TABLE IF NOT EXISTS extensions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    path TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    command_alias TEXT,
    command_hotkey TEXT
);
