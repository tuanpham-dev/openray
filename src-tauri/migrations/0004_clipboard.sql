CREATE TABLE IF NOT EXISTS clipboard_history (
    id TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    text_content TEXT,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_clipboard_history_created_at ON clipboard_history (created_at DESC);
