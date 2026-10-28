-- Requests survive API/worker restarts. Lifecycle remains active until the
-- worker has stopped its browser and acknowledged the request.
ALTER TABLE browser_jobs ADD COLUMN IF NOT EXISTS cancel_id uuid;
ALTER TABLE browser_jobs ADD COLUMN IF NOT EXISTS cancel_requested_at timestamptz;
ALTER TABLE runtime_runs ADD COLUMN IF NOT EXISTS cancel_id uuid;
ALTER TABLE runtime_runs ADD COLUMN IF NOT EXISTS cancel_requested_at timestamptz;
ALTER TABLE runtime_actions DROP CONSTRAINT IF EXISTS runtime_actions_state_check;
ALTER TABLE runtime_actions ADD CONSTRAINT runtime_actions_state_check CHECK (state IN ('prepared','dispatched','completed','interrupted','evidence_failed','skipped','cancelled'));
ALTER TABLE exploration_decisions DROP CONSTRAINT IF EXISTS exploration_decisions_status_check;
ALTER TABLE exploration_decisions ADD CONSTRAINT exploration_decisions_status_check CHECK (status IN ('requested','accepted','rejected','failed','interrupted','cancelled'));
ALTER TABLE model_requests DROP CONSTRAINT IF EXISTS model_requests_state_check;
ALTER TABLE model_requests ADD CONSTRAINT model_requests_state_check CHECK (state IN ('queued','preparing','dispatched','completed','failed','interrupted','cancelled'));
