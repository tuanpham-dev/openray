CREATE TABLE IF NOT EXISTS extension_preference_definitions (
    extension_id TEXT NOT NULL,
    command_name TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    preference_type TEXT NOT NULL,
    title TEXT,
    label TEXT,
    description TEXT,
    required INTEGER NOT NULL DEFAULT 0,
    default_value TEXT,
    placeholder TEXT,
    data TEXT,
    PRIMARY KEY (extension_id, command_name, name)
);

CREATE TABLE IF NOT EXISTS extension_preference_values (
    extension_id TEXT NOT NULL,
    name TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (extension_id, name)
);
