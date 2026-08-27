CREATE TABLE IF NOT EXISTS screenshot_ocr (
    path TEXT PRIMARY KEY,
    mtime INTEGER NOT NULL,
    text TEXT NOT NULL,
    engine TEXT NOT NULL,
    indexed_at INTEGER NOT NULL
);
