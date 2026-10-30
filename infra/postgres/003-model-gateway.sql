-- Local gateway: operational state and authoritative usage live in PostgreSQL.
-- Payload bytea is a durable upload outbox, retained until a future retention policy.
CREATE TABLE IF NOT EXISTS model_requests (
  request_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  run_id uuid REFERENCES runtime_runs(run_id),
  action_id uuid,
  provider text NOT NULL CHECK (provider IN ('openai','anthropic','openrouter','meta')),
  model text NOT NULL,
  execution_mode text NOT NULL DEFAULT 'live' CHECK (execution_mode IN ('live','protocol_fixture')),
  spec jsonb NOT NULL,
  spec_sha256 text NOT NULL,
  state text NOT NULL CHECK (state IN ('queued','preparing','dispatched','completed','failed','interrupted')),
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  error text,
  CHECK (action_id IS NULL OR run_id IS NOT NULL),
  FOREIGN KEY (run_id,action_id) REFERENCES runtime_actions(run_id,action_id)
);
CREATE INDEX IF NOT EXISTS model_requests_queue ON model_requests(next_attempt_at,created_at) WHERE state='queued';
ALTER TABLE model_requests ADD COLUMN IF NOT EXISTS execution_mode text NOT NULL DEFAULT 'live' CHECK (execution_mode IN ('live','protocol_fixture'));

CREATE TABLE IF NOT EXISTS model_calls (
  call_id uuid PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES model_requests(request_id),
  attempt integer NOT NULL,
  state text NOT NULL CHECK (state IN ('dispatched','completed','failed','unknown')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  elapsed_ms bigint,
  http_status integer,
  provider_request_id text,
  returned_model text,
  routed_provider text,
  output_text text,
  finish_reason text,
  error text,
  input_tokens bigint CHECK (input_tokens >= 0),
  output_tokens bigint CHECK (output_tokens >= 0),
  cached_input_tokens bigint CHECK (cached_input_tokens >= 0),
  cache_write_tokens bigint CHECK (cache_write_tokens >= 0),
  reasoning_tokens bigint CHECK (reasoning_tokens >= 0),
  cost_usd numeric CHECK (cost_usd >= 0),
  usage_status text NOT NULL DEFAULT 'unknown' CHECK (usage_status IN ('reported','partial','unknown')),
  usage_reason text,
  usage_raw jsonb,
  response_complete boolean NOT NULL DEFAULT false,
  UNIQUE (request_id,attempt)
);

CREATE TABLE IF NOT EXISTS model_payloads (
  payload_id uuid PRIMARY KEY,
  call_id uuid NOT NULL REFERENCES model_calls(call_id),
  kind text NOT NULL CHECK (kind IN ('request','response')),
  object_key text UNIQUE NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  byte_length bigint NOT NULL,
  body bytea NOT NULL,
  uploaded_at timestamptz,
  UNIQUE (call_id,kind)
);
CREATE INDEX IF NOT EXISTS model_payloads_pending ON model_payloads(payload_id) WHERE uploaded_at IS NULL;

-- Immutable lifecycle events, including dispatches that never return a response.
CREATE TABLE IF NOT EXISTS model_events (
  event_id uuid PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES model_requests(request_id),
  call_id uuid REFERENCES model_calls(call_id),
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL,
  exported_at timestamptz,
  UNIQUE (call_id,event_type)
);
CREATE INDEX IF NOT EXISTS model_events_pending ON model_events(occurred_at) WHERE exported_at IS NULL;
