-- The graph is evidence, not a claim of complete application coverage.
CREATE TABLE IF NOT EXISTS exploration_states (
  state_id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runtime_runs(run_id),
  representative_capture_id uuid NOT NULL REFERENCES runtime_captures(capture_id),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  url text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(run_id,fingerprint), UNIQUE(run_id,state_id)
);
CREATE TABLE IF NOT EXISTS exploration_edges (
  action_id uuid PRIMARY KEY,
  run_id uuid NOT NULL,
  from_state_id uuid NOT NULL,
  to_state_id uuid NOT NULL,
  FOREIGN KEY(run_id,action_id) REFERENCES runtime_actions(run_id,action_id),
  FOREIGN KEY(run_id,from_state_id) REFERENCES exploration_states(run_id,state_id),
  FOREIGN KEY(run_id,to_state_id) REFERENCES exploration_states(run_id,state_id)
);
CREATE TABLE IF NOT EXISTS exploration_frontier (
  frontier_id uuid PRIMARY KEY,
  run_id uuid NOT NULL,
  state_id uuid NOT NULL,
  control_id text NOT NULL,
  control jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('unexplored','attempted','blocked')),
  reason text,
  action_id uuid REFERENCES runtime_actions(action_id),
  FOREIGN KEY(run_id,state_id) REFERENCES exploration_states(run_id,state_id),
  UNIQUE(run_id,state_id,control_id)
);
CREATE TABLE IF NOT EXISTS exploration_decisions (
  decision_id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runtime_runs(run_id),
  action_id uuid REFERENCES runtime_actions(action_id),
  request_id uuid NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('navigation_prediction','plan','assessment')),
  status text NOT NULL CHECK (status IN ('requested','accepted','rejected','failed','interrupted')),
  input_capture_ids uuid[] NOT NULL,
  result jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
-- Request ID intentionally has no FK: it is committed before gateway admission.
CREATE OR REPLACE VIEW exploration_graphs AS
SELECT r.run_id, r.workspace_id,
 jsonb_build_object('schema_version',1,'coverage_complete',false,
 'states',COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.created_at,s.state_id) FROM exploration_states s WHERE s.run_id=r.run_id),'[]'::jsonb),
 'edges',COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY a.ordinal) FROM exploration_edges e JOIN runtime_actions a USING(action_id) WHERE e.run_id=r.run_id),'[]'::jsonb),
 'frontier',COALESCE((SELECT jsonb_agg(to_jsonb(f) ORDER BY f.state_id,f.control_id) FROM exploration_frontier f WHERE f.run_id=r.run_id),'[]'::jsonb),
 'decisions',COALESCE((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.created_at,d.decision_id) FROM exploration_decisions d WHERE d.run_id=r.run_id),'[]'::jsonb)) AS graph
FROM runtime_runs r WHERE r.config->>'runtime_version'='explorer-v1';
