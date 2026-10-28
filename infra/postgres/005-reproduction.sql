CREATE TABLE IF NOT EXISTS runtime_reproductions (
  reproduction_id uuid PRIMARY KEY,
  source_run_id uuid NOT NULL,
  source_action_id uuid NOT NULL UNIQUE,
  replay_run_id uuid NOT NULL UNIQUE REFERENCES runtime_runs(run_id),
  status text NOT NULL CHECK (status IN ('active','completed','interrupted')),
  source_snapshot jsonb NOT NULL,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  FOREIGN KEY(source_run_id,source_action_id) REFERENCES runtime_actions(run_id,action_id)
);
CREATE INDEX IF NOT EXISTS runtime_reproductions_source_run ON runtime_reproductions(source_run_id);
