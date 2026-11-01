-- Continuing an exploration carries its graph into the new run. The stopped
-- run's states and frontier are copied into the continuation, keeping their
-- original screenshots, so a page observed again lands on the same state and
-- its tried, untried and blocked controls carry on. Each copy names the run and
-- state that first recorded it. A continuation of a continuation copies the
-- whole graph again, so chains have no length limit.
ALTER TABLE exploration_states ADD COLUMN IF NOT EXISTS inherited_from_run_id uuid REFERENCES runtime_runs(run_id);
ALTER TABLE exploration_states ADD COLUMN IF NOT EXISTS inherited_from_state_id uuid;
CREATE INDEX IF NOT EXISTS exploration_states_inherited ON exploration_states(run_id) WHERE inherited_from_run_id IS NOT NULL;

-- Transitions an earlier run executed between copied states. Edges belong to
-- their own run's actions, so these are kept apart: the action that recorded
-- each one stays in its source run. Routable transitions settled without a
-- tool, observation or completion failure and can be used to travel back.
CREATE TABLE IF NOT EXISTS exploration_inherited_edges (
  run_id uuid NOT NULL,
  from_state_id uuid NOT NULL,
  to_state_id uuid NOT NULL,
  source_run_id uuid NOT NULL REFERENCES runtime_runs(run_id),
  source_action_id uuid NOT NULL REFERENCES runtime_actions(action_id),
  -- Order of execution across the whole chain, oldest first.
  seq integer NOT NULL CHECK (seq >= 1),
  command jsonb NOT NULL,
  expected_result text NOT NULL,
  control_key text CHECK (control_key ~ '^[0-9a-f]{32}$'),
  routable boolean NOT NULL,
  PRIMARY KEY (run_id, source_action_id),
  FOREIGN KEY (run_id, from_state_id) REFERENCES exploration_states(run_id, state_id),
  FOREIGN KEY (run_id, to_state_id) REFERENCES exploration_states(run_id, state_id)
);

-- Explicit continuations no longer stop after three runs.
ALTER TABLE browser_jobs DROP CONSTRAINT IF EXISTS browser_jobs_resumes_check;

CREATE OR REPLACE VIEW exploration_graphs AS
SELECT r.run_id, r.workspace_id,
 jsonb_build_object('schema_version',2,'coverage_complete',false,
 'states',COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.created_at,s.state_id) FROM exploration_states s WHERE s.run_id=r.run_id),'[]'::jsonb),
 'edges',COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY a.ordinal) FROM exploration_edges e JOIN runtime_actions a USING(action_id) WHERE e.run_id=r.run_id),'[]'::jsonb),
 'inherited_edges',COALESCE((SELECT jsonb_agg(to_jsonb(i) - 'run_id' ORDER BY i.seq) FROM exploration_inherited_edges i WHERE i.run_id=r.run_id),'[]'::jsonb),
 'frontier',COALESCE((SELECT jsonb_agg(to_jsonb(f) ORDER BY f.state_id,f.control_id) FROM exploration_frontier f WHERE f.run_id=r.run_id),'[]'::jsonb),
 'decisions',COALESCE((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.created_at,d.decision_id) FROM exploration_decisions d WHERE d.run_id=r.run_id),'[]'::jsonb),
 'selections',COALESCE((SELECT jsonb_agg(e.payload ORDER BY e.seq) FROM runtime_events e WHERE e.run_id=r.run_id AND e.event_type='exploration.selected'),'[]'::jsonb)) AS graph
FROM runtime_runs r WHERE r.config->>'runtime_version'='explorer-v1';
