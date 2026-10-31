-- Workers run several browser jobs at once and claim queued work from every
-- workspace member. A running job is owned by the Postgres session that holds
-- its advisory lock, so a crashed worker's jobs are recoverable immediately.
ALTER TABLE browser_workers ADD COLUMN IF NOT EXISTS slots integer NOT NULL DEFAULT 1 CHECK (slots BETWEEN 1 AND 8);

-- An interrupted exploration is queued again as a continuation run. Earlier
-- runs stay as evidence; the job points at its newest run.
ALTER TABLE browser_jobs ADD COLUMN IF NOT EXISTS resumes integer NOT NULL DEFAULT 0 CHECK (resumes BETWEEN 0 AND 3);
ALTER TABLE browser_jobs ADD COLUMN IF NOT EXISTS previous_run_ids uuid[] NOT NULL DEFAULT '{}';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='browser_jobs'::regclass AND conname='browser_jobs_resume_history') THEN
    ALTER TABLE browser_jobs ADD CONSTRAINT browser_jobs_resume_history CHECK (cardinality(previous_run_ids)=resumes);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS browser_jobs_running ON browser_jobs(workspace_id) WHERE status='running';
