CREATE TABLE IF NOT EXISTS translate_commands (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    source_lang TEXT NOT NULL,
    target_lang TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS translate_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_text TEXT NOT NULL,
    translated_text TEXT NOT NULL,
    detected_lang TEXT,
    target_lang TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
