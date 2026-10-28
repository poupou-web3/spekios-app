CREATE TABLE IF NOT EXISTS browser_jobs (
  job_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  request jsonb NOT NULL,
  settings jsonb NOT NULL,
  execution_mode text NOT NULL CHECK (execution_mode IN ('live','protocol_fixture')),
  status text NOT NULL CHECK (status IN ('queued','running','completed','failed','interrupted')),
  worker_id uuid,
  run_id uuid REFERENCES runtime_runs(run_id),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS browser_jobs_queue ON browser_jobs(created_at) WHERE status='queued';
CREATE TABLE IF NOT EXISTS browser_workers (
  worker_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('online','stopped')),
  started_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now()
);
