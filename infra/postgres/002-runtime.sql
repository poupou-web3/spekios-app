CREATE TABLE IF NOT EXISTS runtime_runs (
  run_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  target_url text NOT NULL,
  lifecycle text NOT NULL CHECK (lifecycle IN ('active','completed','failed')),
  event_seq bigint NOT NULL DEFAULT 0,
  config jsonb NOT NULL,
  manifest_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  error text
);
CREATE TABLE IF NOT EXISTS runtime_actions (
  action_id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runtime_runs(run_id),
  ordinal integer NOT NULL,
  prediction_id uuid UNIQUE NOT NULL,
  spec jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('prepared','dispatched','completed','evidence_failed','interrupted')),
  before_capture_id uuid,
  after_capture_id uuid,
  comparison jsonb,
  assessment jsonb,
  tool_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  finished_at timestamptz,
  UNIQUE (run_id, ordinal),
  UNIQUE (run_id, action_id)
);
CREATE TABLE IF NOT EXISTS runtime_captures (
  capture_id uuid PRIMARY KEY,
  run_id uuid NOT NULL,
  action_id uuid NOT NULL,
  phase text NOT NULL CHECK (phase IN ('before','after')),
  status text NOT NULL CHECK (status IN ('capturing','pending_upload','available','failed')),
  object_key text,
  metadata_key text,
  sha256 text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  byte_length bigint,
  observation jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (run_id,action_id) REFERENCES runtime_actions(run_id,action_id),
  UNIQUE (action_id,phase)
);
CREATE TABLE IF NOT EXISTS runtime_artifacts (
  artifact_id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runtime_runs(run_id),
  kind text NOT NULL,
  object_key text NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  byte_length bigint NOT NULL,
  status text NOT NULL CHECK (status IN ('pending_upload','available')),
  UNIQUE (run_id,kind,object_key)
);
CREATE TABLE IF NOT EXISTS runtime_events (
  event_id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runtime_runs(run_id),
  seq bigint NOT NULL,
  event_type text NOT NULL,
  action_id uuid,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  exported_at timestamptz,
  UNIQUE (run_id,seq)
);
CREATE INDEX IF NOT EXISTS runtime_events_pending ON runtime_events(occurred_at) WHERE exported_at IS NULL;
