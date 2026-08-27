CREATE TABLE IF NOT EXISTS window_commands (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    unit TEXT NOT NULL,
    x REAL,
    y REAL,
    width REAL NOT NULL,
    height REAL NOT NULL,
    created_at INTEGER NOT NULL
);
