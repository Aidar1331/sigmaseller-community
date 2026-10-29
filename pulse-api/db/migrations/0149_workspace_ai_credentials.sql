CREATE TABLE IF NOT EXISTS workspace_ai_credentials (
  workspace_id integer NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('anthropic','openai','google','runway','voyage','jina','web_search')),
  encrypted_key text NOT NULL,
  key_suffix varchar(4) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, provider)
);
