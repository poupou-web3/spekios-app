-- Public MCP clients use browser consent and PKCE. Only hashes of one-time
-- codes, access tokens and rotating refresh tokens are retained.
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id text PRIMARY KEY,
  name text NOT NULL,
  redirect_uris text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS oauth_authorizations (
  authorization_id uuid PRIMARY KEY,
  client_id text NOT NULL REFERENCES oauth_clients(client_id),
  redirect_uri text NOT NULL,
  resource text NOT NULL,
  challenge text NOT NULL,
  state text,
  scopes text[] NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','denied','consumed')),
  workspace_id uuid REFERENCES workspaces(workspace_id),
  code_sha256 text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes'
);
CREATE TABLE IF NOT EXISTS oauth_sessions (
  session_id uuid PRIMARY KEY,
  client_id text NOT NULL REFERENCES oauth_clients(client_id),
  workspace_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  resource text NOT NULL,
  scopes text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '30 days',
  revoked_at timestamptz,
  FOREIGN KEY(workspace_id,agent_id) REFERENCES agent_identities(workspace_id,agent_id)
);
CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  token_sha256 text PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES oauth_sessions(session_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz
);
ALTER TABLE workspace_credentials ADD COLUMN IF NOT EXISTS audience text;
ALTER TABLE workspace_credentials ADD COLUMN IF NOT EXISTS oauth_session_id uuid REFERENCES oauth_sessions(session_id);
CREATE INDEX IF NOT EXISTS oauth_refresh_session ON oauth_refresh_tokens(session_id);
CREATE INDEX IF NOT EXISTS oauth_credentials_session ON workspace_credentials(oauth_session_id) WHERE oauth_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS oauth_authorizations_expiry ON oauth_authorizations(expires_at) WHERE status IN ('pending','approved');
