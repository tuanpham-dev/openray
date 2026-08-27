ALTER TABLE extensions ADD COLUMN description TEXT;
ALTER TABLE extensions ADD COLUMN source TEXT NOT NULL DEFAULT 'builtin';

CREATE TABLE IF NOT EXISTS extension_commands (
    extension_id TEXT NOT NULL,
    name TEXT NOT NULL,
    title TEXT NOT NULL,
    subtitle TEXT,
    description TEXT,
    mode TEXT NOT NULL,
    keywords TEXT,
    PRIMARY KEY (extension_id, name)
);
