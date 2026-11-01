-- A suspected overlap gets one longer look: the explorer captures the page
-- again after a wait and the action points at that later screenshot. The
-- earlier one stays as evidence (layout_recheck.earlier_after_capture_id), so
-- an action can have more than one 'after' capture. It keeps one 'before'.
ALTER TABLE runtime_captures DROP CONSTRAINT IF EXISTS runtime_captures_action_id_phase_key;
CREATE UNIQUE INDEX IF NOT EXISTS runtime_captures_one_before ON runtime_captures(action_id) WHERE phase='before';
CREATE INDEX IF NOT EXISTS runtime_captures_action ON runtime_captures(action_id, phase);
