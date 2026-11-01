-- A planning decision can reuse what the model ranked on the same screen in
-- an earlier run instead of asking again. It is recorded as its own decision
-- with status 'reused' and a fresh request ID that has no model request.
ALTER TABLE exploration_decisions DROP CONSTRAINT IF EXISTS exploration_decisions_status_check;
ALTER TABLE exploration_decisions ADD CONSTRAINT exploration_decisions_status_check CHECK (status IN ('requested','accepted','rejected','failed','interrupted','cancelled','reused'));

-- Rankings carried between runs, per app memory scope, screen signature and
-- model. Proposals are keyed by control entry; typed text is never stored.
-- Forgetting the scope removes them; run evidence stays.
CREATE TABLE IF NOT EXISTS app_map_rankings (
  scope_id uuid NOT NULL REFERENCES app_memory_scopes(scope_id) ON DELETE CASCADE,
  signature text NOT NULL CHECK (signature ~ '^[0-9a-f]{32}$'),
  provider text NOT NULL CHECK (provider IN ('openai','anthropic','openrouter','meta')),
  model text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 200),
  state_key text CHECK (state_key ~ '^[0-9a-f]{32}$'),
  proposals jsonb NOT NULL CHECK (jsonb_typeof(proposals) = 'array' AND jsonb_array_length(proposals) BETWEEN 1 AND 8),
  source_run_id uuid NOT NULL REFERENCES runtime_runs(run_id),
  source_request_id uuid NOT NULL,
  source_decision_id uuid NOT NULL,
  reuses integer NOT NULL DEFAULT 0 CHECK (reuses >= 0),
  last_reused_run_id uuid REFERENCES runtime_runs(run_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_reused_at timestamptz,
  PRIMARY KEY (scope_id, signature, provider, model)
);
