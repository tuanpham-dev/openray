CREATE TABLE IF NOT EXISTS quicklinks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    url_template TEXT NOT NULL,
    icon TEXT,
    created_at INTEGER NOT NULL
);
