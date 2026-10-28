-- Authentication material lives only in the encrypted worker vault, never here.
ALTER TABLE runtime_runs DROP CONSTRAINT IF EXISTS runtime_runs_lifecycle_check;
ALTER TABLE runtime_runs ADD CONSTRAINT runtime_runs_lifecycle_check CHECK (lifecycle IN ('active','completed','failed','blocked','cancelled'));
ALTER TABLE browser_jobs DROP CONSTRAINT IF EXISTS browser_jobs_status_check;
ALTER TABLE browser_jobs ADD CONSTRAINT browser_jobs_status_check CHECK (status IN ('queued','running','completed','failed','interrupted','blocked','cancelled'));
CREATE TABLE IF NOT EXISTS browser_sessions (
  session_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  origin text NOT NULL,
  execution_mode text NOT NULL CHECK (execution_mode IN ('live','protocol_fixture')),
  created_by_run_id uuid NOT NULL REFERENCES runtime_runs(run_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  verification text NOT NULL
);
CREATE TABLE IF NOT EXISTS browser_access_requests (
  access_id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runtime_runs(run_id),
  job_id uuid REFERENCES browser_jobs(job_id),
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  origin text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('login_required','login_available','user_requested','session_expired')),
  status text NOT NULL CHECK (status IN ('waiting','active','completed','skipped','cancelled','expired','interrupted')),
  session_id uuid REFERENCES browser_sessions(session_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  finished_at timestamptz,
  verification text
);
CREATE INDEX IF NOT EXISTS browser_access_pending ON browser_access_requests(workspace_id,created_at) WHERE status IN ('waiting','active');
