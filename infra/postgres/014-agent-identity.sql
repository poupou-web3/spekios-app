-- Identity is independent of a conversation or a guessed run UUID. Existing
-- recordings stay private and retain their original local ownership.
CREATE TABLE IF NOT EXISTS workspaces (
  workspace_id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO workspaces(workspace_id,owner_user_id,name)
VALUES('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','Local workspace')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS agent_identities (
  agent_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(workspace_id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE(workspace_id,agent_id)
);
CREATE TABLE IF NOT EXISTS workspace_credentials (
  credential_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(workspace_id),
  agent_id uuid REFERENCES agent_identities(agent_id),
  token_sha256 text UNIQUE NOT NULL CHECK(token_sha256 ~ '^[0-9a-f]{64}$'),
  scopes text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_used_at timestamptz,
  FOREIGN KEY(workspace_id,agent_id) REFERENCES agent_identities(workspace_id,agent_id)
);
CREATE TABLE IF NOT EXISTS agent_connections (
  connection_id uuid PRIMARY KEY,
  device_sha256 text UNIQUE NOT NULL,
  user_code text UNIQUE NOT NULL,
  challenge text NOT NULL CHECK(challenge ~ '^[0-9a-f]{64}$'),
  agent_name text NOT NULL,
  scopes text[] NOT NULL,
  status text NOT NULL CHECK(status IN ('pending','approved','denied','consumed')),
  workspace_id uuid REFERENCES workspaces(workspace_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes',
  last_poll_at timestamptz,
  agent_id uuid REFERENCES agent_identities(agent_id)
);
CREATE TABLE IF NOT EXISTS identity_audit (
  event_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(workspace_id),
  agent_id uuid,
  credential_id uuid,
  operation text NOT NULL,
  outcome text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  exported_at timestamptz
);
CREATE INDEX IF NOT EXISTS identity_audit_pending ON identity_audit(occurred_at) WHERE exported_at IS NULL;
ALTER TABLE browser_jobs ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES agent_identities(agent_id);
ALTER TABLE browser_jobs ADD COLUMN IF NOT EXISTS project_id uuid;
ALTER TABLE browser_jobs ADD COLUMN IF NOT EXISTS task_id uuid;
CREATE INDEX IF NOT EXISTS browser_jobs_identity ON browser_jobs(workspace_id,agent_id,created_at DESC);
CREATE INDEX IF NOT EXISTS runtime_runs_history ON runtime_runs(workspace_id,user_id,created_at DESC,run_id DESC);

ALTER TABLE model_requests ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES agent_identities(agent_id);
ALTER TABLE identity_audit ADD COLUMN IF NOT EXISTS request_id uuid;
