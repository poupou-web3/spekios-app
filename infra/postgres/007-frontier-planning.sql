ALTER TABLE exploration_states ADD COLUMN IF NOT EXISTS planning jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE exploration_frontier ADD COLUMN IF NOT EXISTS planning jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE runtime_actions DROP CONSTRAINT IF EXISTS runtime_actions_state_check;
ALTER TABLE runtime_actions ADD CONSTRAINT runtime_actions_state_check
  CHECK (state IN ('prepared','dispatched','completed','evidence_failed','interrupted','skipped','cancelled'));
CREATE OR REPLACE VIEW exploration_graphs AS
SELECT r.run_id, r.workspace_id,
 jsonb_build_object('schema_version',2,'coverage_complete',false,
 'states',COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.created_at,s.state_id) FROM exploration_states s WHERE s.run_id=r.run_id),'[]'::jsonb),
 'edges',COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY a.ordinal) FROM exploration_edges e JOIN runtime_actions a USING(action_id) WHERE e.run_id=r.run_id),'[]'::jsonb),
 'frontier',COALESCE((SELECT jsonb_agg(to_jsonb(f) ORDER BY f.state_id,f.control_id) FROM exploration_frontier f WHERE f.run_id=r.run_id),'[]'::jsonb),
 'decisions',COALESCE((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.created_at,d.decision_id) FROM exploration_decisions d WHERE d.run_id=r.run_id),'[]'::jsonb),
 'selections',COALESCE((SELECT jsonb_agg(e.payload ORDER BY e.seq) FROM runtime_events e WHERE e.run_id=r.run_id AND e.event_type='exploration.selected'),'[]'::jsonb)) AS graph
FROM runtime_runs r WHERE r.config->>'runtime_version'='explorer-v1';
