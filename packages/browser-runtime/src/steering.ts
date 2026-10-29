import type { Store } from './store.js';

export type PlanningFocus = { steering_id: string; revision: number; focus: string };

// Called only inside decision admission with the run row already locked by
// RunControl. API writes/finalization use the same lock, so an in-flight action
// and its frozen assessment can never acquire a newer instruction halfway in.
export async function planningFocus(store: Store, runId: string, decisionId: string): Promise<PlanningFocus|null> {
  await store.query(`UPDATE run_steering SET status='applied',decision_id=$2,acknowledged_at=now(),reason='included_in_planning_decision'
    WHERE run_id=$1 AND status='pending'`, [runId,decisionId]);
  return (await store.query(`SELECT steering_id,revision,focus FROM run_steering WHERE run_id=$1 AND status='applied'
    ORDER BY revision DESC LIMIT 1`, [runId])).rows[0] ?? null;
}
