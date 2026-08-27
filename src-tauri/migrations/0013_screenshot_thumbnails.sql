CREATE TABLE IF NOT EXISTS screenshot_thumbnails (
    path TEXT PRIMARY KEY,
    mtime INTEGER NOT NULL,
    thumb TEXT NOT NULL,
    generated_at INTEGER NOT NULL
);
