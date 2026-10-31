import { randomUUID } from 'node:crypto';
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

// A resumed run starts with the newest focus of the run it continues. It is
// pending until that run's first planning decision, like any other focus.
export async function carryFocus(store: Store, fromRunId: string, toRunId: string): Promise<string|null> {
  const latest = (await store.query(`SELECT focus,agent_id FROM run_steering WHERE run_id=$1 AND status IN ('pending','applied')
    ORDER BY revision DESC LIMIT 1`, [fromRunId])).rows[0];
  if (!latest?.focus) return null;
  await store.query(`INSERT INTO run_steering(steering_id,run_id,workspace_id,user_id,agent_id,revision,focus,status,reason)
    VALUES($1,$2,$3,$4,$5,1,$6,'pending','carried_from_interrupted_run')`, [randomUUID(), toRunId, store.workspaceId, store.userId, latest.agent_id, latest.focus]);
  return latest.focus;
}
