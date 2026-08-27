ALTER TABLE ai_provider_keys ADD COLUMN base_url TEXT;

ALTER TABLE ai_chats ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_chats ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_chats ADD COLUMN quick INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_chats ADD COLUMN agent_id TEXT;
ALTER TABLE ai_chats ADD COLUMN model TEXT;

CREATE TABLE IF NOT EXISTS ai_agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon TEXT,
    instructions TEXT NOT NULL,
    model TEXT,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_commands (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    model TEXT,
    creativity TEXT NOT NULL DEFAULT 'medium',
    output_mode TEXT NOT NULL DEFAULT 'view',
    builtin INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon TEXT,
    transport TEXT NOT NULL,
    command TEXT,
    args TEXT,
    env TEXT,
    url TEXT,
    headers TEXT,
    oauth_type TEXT,
    oauth_client_id TEXT,
    oauth_client_secret TEXT,
    oauth_scopes TEXT,
    instructions TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    always_allow INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_oauth_tokens (
    server_id TEXT PRIMARY KEY REFERENCES mcp_servers(id) ON DELETE CASCADE,
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    expires_at INTEGER
);
