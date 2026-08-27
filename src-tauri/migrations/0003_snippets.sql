CREATE TABLE IF NOT EXISTS snippets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    keyword TEXT,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
