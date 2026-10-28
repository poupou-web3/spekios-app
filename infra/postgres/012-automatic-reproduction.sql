-- Opt-in source batches are planned once and remain durable across worker
-- restarts. Child jobs use the ordinary reproduction/cancellation machinery.
ALTER TABLE browser_jobs ADD COLUMN IF NOT EXISTS parent_job_id uuid REFERENCES browser_jobs(job_id);
ALTER TABLE browser_jobs ADD COLUMN IF NOT EXISTS automatic_source_action_id uuid UNIQUE REFERENCES runtime_actions(action_id);
ALTER TABLE browser_jobs ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE runtime_runs ADD COLUMN IF NOT EXISTS auto_reproduction_planned_at timestamptz;
ALTER TABLE runtime_runs ADD COLUMN IF NOT EXISTS auto_reproduction_cancel_id uuid;
ALTER TABLE runtime_runs ADD COLUMN IF NOT EXISTS auto_reproduction_cancelled_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS browser_jobs_job_run_identity ON browser_jobs(job_id,run_id);
CREATE UNIQUE INDEX IF NOT EXISTS browser_jobs_automatic_identity ON browser_jobs(job_id,parent_job_id,automatic_source_action_id);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='browser_jobs'::regclass AND conname='browser_jobs_automatic_pair') THEN
    ALTER TABLE browser_jobs ADD CONSTRAINT browser_jobs_automatic_pair CHECK ((
      (parent_job_id IS NULL AND automatic_source_action_id IS NULL) OR
      (parent_job_id IS NOT NULL AND automatic_source_action_id IS NOT NULL
       AND parent_job_id<>job_id AND request->>'kind'='reproduce'
       AND request->>'source_action_id'=automatic_source_action_id::text
       AND settings->'autoReproduce'='false'::jsonb)
    ) IS TRUE);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS automatic_reproduction_tasks (
  task_id uuid PRIMARY KEY,
  source_run_id uuid NOT NULL REFERENCES runtime_runs(run_id),
  source_job_id uuid NOT NULL REFERENCES browser_jobs(job_id),
  source_action_id uuid NOT NULL UNIQUE REFERENCES runtime_actions(action_id),
  status text NOT NULL CHECK (status IN ('pending','queued','skipped')),
  reason text,
  planned_actions integer NOT NULL CHECK (planned_actions BETWEEN 0 AND 12),
  child_job_id uuid UNIQUE REFERENCES browser_jobs(job_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (source_run_id,source_action_id) REFERENCES runtime_actions(run_id,action_id),
  FOREIGN KEY (source_job_id,source_run_id) REFERENCES browser_jobs(job_id,run_id),
  FOREIGN KEY (child_job_id,source_job_id,source_action_id) REFERENCES browser_jobs(job_id,parent_job_id,automatic_source_action_id),
  CHECK (status='skipped' OR (status='queued' AND child_job_id IS NOT NULL) OR (status='pending' AND child_job_id IS NULL))
);
CREATE INDEX IF NOT EXISTS automatic_reproduction_tasks_source ON automatic_reproduction_tasks(source_run_id,created_at,task_id);
CREATE INDEX IF NOT EXISTS automatic_reproduction_tasks_pending ON automatic_reproduction_tasks(created_at,task_id) WHERE status='pending';
