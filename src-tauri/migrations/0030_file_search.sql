CREATE TABLE IF NOT EXISTS file_search_index (
    path TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    mtime INTEGER NOT NULL,
    indexed_at INTEGER NOT NULL
);
