-- Product-owned connector state only. Analytics and recordings live in PostHog Cloud.
CREATE TABLE IF NOT EXISTS posthog_connections (
  connection_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(workspace_id),
  user_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  host text NOT NULL,
  project_id text NOT NULL,
  source_origin text NOT NULL,
  replay_origin text NOT NULL,
  encrypted_key bytea NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  auto_replay boolean NOT NULL DEFAULT false,
  scan jsonb,
  last_synced_at timestamptz,
  next_sync_at timestamptz NOT NULL DEFAULT now(),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,user_id,host,project_id,source_origin)
);
CREATE INDEX IF NOT EXISTS posthog_connections_owner ON posthog_connections(workspace_id,user_id);
-- Additive for checkouts that already ran an earlier connector migration.
ALTER TABLE posthog_connections ADD COLUMN IF NOT EXISTS analysis jsonb;
ALTER TABLE posthog_connections ADD COLUMN IF NOT EXISTS analysis_updated_at timestamptz;
ALTER TABLE posthog_connections ADD COLUMN IF NOT EXISTS analysis_error text;
ALTER TABLE posthog_connections ADD COLUMN IF NOT EXISTS next_analysis_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS posthog_worker_status (
  worker_id text PRIMARY KEY CHECK(worker_id='importer'),
  heartbeat_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS posthog_workflows (
  workflow_id uuid PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES posthog_connections ON DELETE CASCADE,
  fingerprint text NOT NULL,
  title text NOT NULL,
  steps jsonb NOT NULL,
  issues jsonb NOT NULL,
  executable boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(connection_id,fingerprint)
);
CREATE TABLE IF NOT EXISTS posthog_sessions (
  connection_id uuid NOT NULL REFERENCES posthog_connections ON DELETE CASCADE,
  session_id text NOT NULL,
  workflow_id uuid REFERENCES posthog_workflows ON DELETE SET NULL,
  started_at timestamptz NOT NULL,
  ongoing boolean NOT NULL,
  event_count integer NOT NULL,
  snapshot_status text NOT NULL,
  issues jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(connection_id,session_id)
);
CREATE INDEX IF NOT EXISTS posthog_sessions_workflow ON posthog_sessions(workflow_id);
CREATE TABLE IF NOT EXISTS posthog_replays (
  replay_id uuid PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES posthog_connections ON DELETE CASCADE,
  workflow_id uuid NOT NULL REFERENCES posthog_workflows ON DELETE CASCADE,
  automatic boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','blocked','failed','interrupted')),
  steps jsonb NOT NULL,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS posthog_replay_pending ON posthog_replays(workflow_id) WHERE status IN ('queued','running');
-- One automatic validation per distinct inferred workflow. Failures stay visible.
CREATE UNIQUE INDEX IF NOT EXISTS posthog_replay_automatic ON posthog_replays(workflow_id) WHERE automatic;
