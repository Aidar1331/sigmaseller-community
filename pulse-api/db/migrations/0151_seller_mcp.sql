-- Community MCP: only hashes of bearer credentials, scoped grants and immutable proposals.
CREATE TABLE IF NOT EXISTS seller_oauth_clients (
  client_id text PRIMARY KEY, client_name text NOT NULL, redirect_uris jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS seller_oauth_grants (
  id uuid PRIMARY KEY, client_id text NOT NULL REFERENCES seller_oauth_clients(client_id),
  user_id bigint NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  workspace_id bigint NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  shop_id bigint NOT NULL REFERENCES marketplace_shops(shop_id) ON DELETE CASCADE,
  scopes text[] NOT NULL, resource text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now() + interval '30 days',
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS seller_oauth_grants_user_idx ON seller_oauth_grants(user_id, workspace_id);
CREATE TABLE IF NOT EXISTS seller_oauth_codes (
  hash text PRIMARY KEY, grant_id uuid NOT NULL REFERENCES seller_oauth_grants(id) ON DELETE CASCADE,
  redirect_uri text NOT NULL, challenge text NOT NULL, expires_at timestamptz NOT NULL DEFAULT now() + interval '5 minutes',
  used_at timestamptz
);
CREATE TABLE IF NOT EXISTS seller_oauth_tokens (
  hash text PRIMARY KEY, grant_id uuid NOT NULL REFERENCES seller_oauth_grants(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('access','refresh')), expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX IF NOT EXISTS seller_oauth_tokens_grant_idx ON seller_oauth_tokens(grant_id);
CREATE TABLE IF NOT EXISTS seller_ai_drafts (
  id uuid PRIMARY KEY, workspace_id bigint NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  shop_id bigint NOT NULL REFERENCES marketplace_shops(shop_id) ON DELETE CASCADE,
  user_id bigint NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  grant_id uuid REFERENCES seller_oauth_grants(id) ON DELETE SET NULL,
  title text NOT NULL, content text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS seller_ai_proposals (
  id uuid PRIMARY KEY, workspace_id bigint NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  shop_id bigint NOT NULL REFERENCES marketplace_shops(shop_id) ON DELETE CASCADE,
  user_id bigint NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  grant_id uuid REFERENCES seller_oauth_grants(id) ON DELETE CASCADE,
  payload jsonb NOT NULL, payload_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','executing','accepted','rejected','unknown','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now() + interval '15 minutes',
  confirmed_at timestamptz, finished_at timestamptz, result jsonb
);
CREATE INDEX IF NOT EXISTS seller_ai_proposals_scope_idx ON seller_ai_proposals(workspace_id,shop_id,created_at DESC);
CREATE TABLE IF NOT EXISTS seller_ai_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL, workspace_id bigint NOT NULL, shop_id bigint NOT NULL,
  grant_id uuid, operation text NOT NULL, outcome text NOT NULL, reference_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS seller_ai_audit_scope_idx ON seller_ai_audit(workspace_id,shop_id,created_at DESC);
-- A database lease bounds concurrent paid chat turns across processes. No prompt/token is stored here.
CREATE TABLE IF NOT EXISTS seller_ai_chat_leases (
  workspace_id bigint PRIMARY KEY REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  lease_id uuid NOT NULL, expires_at timestamptz NOT NULL
);
-- Team removal must remain a revocation even if the user is invited back later.
CREATE OR REPLACE FUNCTION seller_revoke_team_connections() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE seller_oauth_grants SET revoked_at=now()
    WHERE user_id=OLD.user_id AND workspace_id=OLD.workspace_id AND revoked_at IS NULL;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS seller_revoke_team_connections_trigger ON workspace_members;
CREATE TRIGGER seller_revoke_team_connections_trigger AFTER DELETE OR UPDATE OF role ON workspace_members
  FOR EACH ROW EXECUTE FUNCTION seller_revoke_team_connections();
