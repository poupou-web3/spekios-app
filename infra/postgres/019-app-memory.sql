-- Cross-run exploration memory: a derived, rebuildable projection of earlier
-- runs. Pages and controls are keyed by observed URL and stable control
-- identity (URL, role, name, href); exact screenshot states are never compared
-- across runs. Run evidence stays authoritative; forgetting a scope deletes only
-- this projection.
CREATE TABLE IF NOT EXISTS app_memory_scopes (
  scope_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  origin text NOT NULL CHECK (char_length(origin) BETWEEN 1 AND 2048),
  viewport_profile text NOT NULL CHECK (viewport_profile IN ('desktop','tablet','mobile')),
  auth_scope text NOT NULL CHECK (auth_scope IN ('public','signed_in')),
  execution_mode text NOT NULL CHECK (execution_mode IN ('live','protocol_fixture')),
  runs integer NOT NULL DEFAULT 0 CHECK (runs >= 0),
  last_run_id uuid REFERENCES runtime_runs(run_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id,user_id,origin,viewport_profile,auth_scope,execution_mode)
);
CREATE TABLE IF NOT EXISTS app_memory_pages (
  scope_id uuid NOT NULL REFERENCES app_memory_scopes(scope_id) ON DELETE CASCADE,
  url text NOT NULL CHECK (char_length(url) BETWEEN 1 AND 2048),
  title text CHECK (char_length(title) <= 200),
  visits integer NOT NULL DEFAULT 1 CHECK (visits > 0),
  best_path_score double precision CHECK (best_path_score BETWEEN 0 AND 1),
  controls_truncated boolean NOT NULL DEFAULT false,
  first_run_id uuid NOT NULL REFERENCES runtime_runs(run_id),
  last_run_id uuid NOT NULL REFERENCES runtime_runs(run_id),
  last_action_id uuid REFERENCES runtime_actions(action_id),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_id,url)
);
CREATE TABLE IF NOT EXISTS app_memory_controls (
  scope_id uuid NOT NULL,
  url text NOT NULL,
  control_id text NOT NULL CHECK (control_id ~ '^[0-9a-f]{24}$'),
  control jsonb NOT NULL CHECK (jsonb_typeof(control) = 'object'),
  blocked_reason text,
  observations integer NOT NULL DEFAULT 1 CHECK (observations > 0),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  best_likelihood double precision CHECK (best_likelihood BETWEEN 0 AND 1),
  last_verdict text CHECK (last_verdict IN ('no_issue_observed','suspect','inconclusive')),
  last_observed_result text CHECK (char_length(last_observed_result) <= 300),
  first_run_id uuid NOT NULL REFERENCES runtime_runs(run_id),
  last_run_id uuid NOT NULL REFERENCES runtime_runs(run_id),
  last_action_id uuid REFERENCES runtime_actions(action_id),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_attempted_at timestamptz,
  PRIMARY KEY (scope_id,url,control_id),
  FOREIGN KEY (scope_id,url) REFERENCES app_memory_pages(scope_id,url) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS app_memory_scopes_owner ON app_memory_scopes(workspace_id,user_id,updated_at DESC);
CREATE INDEX IF NOT EXISTS app_memory_pages_recent ON app_memory_pages(scope_id,last_seen_at DESC);
CREATE INDEX IF NOT EXISTS app_memory_controls_recent ON app_memory_controls(scope_id,last_seen_at DESC);
