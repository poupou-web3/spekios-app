-- The app map is the exploration tree carried between runs. Each recorded
-- state gets a map key: its page template (/orders/:n) and the controls it
-- offers, with repeated list items collapsed. Each recorded edge gets the key
-- of what was done. Exact screenshot states stay per-run evidence.
ALTER TABLE exploration_states ADD COLUMN IF NOT EXISTS map_state_key text CHECK (map_state_key ~ '^[0-9a-f]{32}$');
ALTER TABLE exploration_states ADD COLUMN IF NOT EXISTS page_template text CHECK (char_length(page_template) <= 2048);
ALTER TABLE exploration_edges ADD COLUMN IF NOT EXISTS control_key text CHECK (control_key ~ '^[0-9a-f]{32}$');
CREATE INDEX IF NOT EXISTS exploration_states_map_key ON exploration_states(map_state_key) WHERE map_state_key IS NOT NULL;

-- The cross-run projection, per app memory scope (app, screen size, sign-in
-- state, model mode). Forgetting the scope removes it; run evidence stays.
CREATE TABLE IF NOT EXISTS app_map_states (
  scope_id uuid NOT NULL REFERENCES app_memory_scopes(scope_id) ON DELETE CASCADE,
  state_key text NOT NULL CHECK (state_key ~ '^[0-9a-f]{32}$'),
  page_template text NOT NULL CHECK (char_length(page_template) <= 2048),
  example_url text NOT NULL CHECK (char_length(example_url) <= 2048),
  title text CHECK (char_length(title) <= 300),
  controls jsonb NOT NULL CHECK (jsonb_typeof(controls) = 'array' AND jsonb_array_length(controls) <= 200),
  controls_truncated boolean NOT NULL DEFAULT false,
  observations integer NOT NULL DEFAULT 1 CHECK (observations > 0),
  runs integer NOT NULL DEFAULT 1 CHECK (runs > 0),
  min_depth integer NOT NULL CHECK (min_depth >= 0),
  first_run_id uuid NOT NULL REFERENCES runtime_runs(run_id),
  last_run_id uuid NOT NULL REFERENCES runtime_runs(run_id),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_id, state_key)
);
CREATE INDEX IF NOT EXISTS app_map_states_depth ON app_map_states(scope_id, min_depth, page_template);

-- One row per (state, what was done, resulting state). A control that leads
-- somewhere else in a later run gets a second row, which is how a changed
-- destination shows up.
CREATE TABLE IF NOT EXISTS app_map_transitions (
  scope_id uuid NOT NULL REFERENCES app_memory_scopes(scope_id) ON DELETE CASCADE,
  from_key text NOT NULL CHECK (from_key ~ '^[0-9a-f]{32}$'),
  control_key text NOT NULL CHECK (control_key ~ '^[0-9a-f]{32}$'),
  to_key text NOT NULL CHECK (to_key ~ '^[0-9a-f]{32}$'),
  -- The state's control entry this acted on; untried entries are the map's frontier.
  entry_key text CHECK (entry_key ~ '^[0-9a-f]{32}$'),
  action text NOT NULL CHECK (action IN ('navigate','click','fill','select','set_checked','scroll','submit')),
  control jsonb NOT NULL CHECK (jsonb_typeof(control) = 'object'),
  attempts integer NOT NULL DEFAULT 1 CHECK (attempts > 0),
  verdicts jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(verdicts) = 'object'),
  last_verdict text CHECK (last_verdict IN ('no_issue_observed','suspect','inconclusive')),
  last_observed_result text CHECK (char_length(last_observed_result) <= 300),
  first_run_id uuid NOT NULL REFERENCES runtime_runs(run_id),
  last_run_id uuid NOT NULL REFERENCES runtime_runs(run_id),
  last_action_id uuid NOT NULL REFERENCES runtime_actions(action_id),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_id, from_key, control_key, to_key)
);
CREATE INDEX IF NOT EXISTS app_map_transitions_to ON app_map_transitions(scope_id, to_key);
