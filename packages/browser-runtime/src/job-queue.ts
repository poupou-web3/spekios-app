import type { Store } from './store.js';

export const INTERRUPTED = 'Worker stopped during execution. No browser action was repeated.';
export const CANCELLED = 'Cancelled. No browser action was repeated.';

export const jobLock = (jobId: string) => 'job:' + jobId;

// Any workspace member's queued job. The worker that commits this also holds jobLock
// on the same connection, so a crash releases the claim immediately.
export const CLAIM_CANDIDATE = `SELECT job_id FROM browser_jobs
  WHERE status='queued' AND next_attempt_at<=now() AND execution_mode=$1
    AND (automatic_source_action_id IS NULL OR settings->>'provider'=ANY($2::text[]))
  ORDER BY created_at, job_id
  FOR UPDATE SKIP LOCKED
  LIMIT 1`;
export const CLAIM_JOB = `UPDATE browser_jobs SET status='running', worker_id=$2, started_at=now()
  WHERE job_id=$1 AND status='queued' RETURNING *`;

// Legacy automatic continuations keep spending the original action budget.
// A person asking to continue spends the new job's own limit from the frontier.
export function resumeBudget(job: { continueFrom?: boolean; maxActions?: number | null }, carried: number):
  { maxActions: number | null; carriedActions: number } | { stop: true } {
  const budget = job.maxActions;
  const fresh = job.continueFrom === true;
  const remaining = fresh || budget == null ? (budget == null ? Infinity : budget) : budget - carried;
  if (!(remaining >= 1)) return { stop: true };
  return { maxActions: remaining === Infinity ? null : remaining, carriedActions: fresh ? 0 : carried };
}

export function runIdList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && id.length > 0) : [];
}

export async function dispatchedCount(store: Store, runIds: string[]) {
  if (!runIds.length) return 0;
  return Number((await store.query('SELECT count(*)::int AS n FROM runtime_actions WHERE run_id=ANY($1::uuid[]) AND dispatched_at IS NOT NULL', [runIds])).rows[0].n);
}

// Serialize claims so the running-job count cannot exceed the browser slots.
export async function claimJob(session: Store, workerId: string, executionMode: string, providers: string[], slots: number) {
  let claimed: Record<string, any> | null = null;
  let lockedId: string | null = null;
  try {
    await session.transaction(async () => {
      await session.query("SELECT pg_advisory_xact_lock(hashtextextended('scout-job-claim',0))");
      const running = Number((await session.query("SELECT count(*)::int AS n FROM browser_jobs WHERE status='running'")).rows[0].n);
      if (running >= slots) return;
      const candidate = (await session.query(CLAIM_CANDIDATE, [executionMode, providers])).rows[0];
      if (!candidate) return;
      const job = (await session.query(CLAIM_JOB, [candidate.job_id, workerId])).rows[0] ?? null;
      if (!job) return;
      if (!await session.tryLock(jobLock(job.job_id))) throw new Error('job lock unavailable');
      lockedId = job.job_id;
      claimed = job;
    });
  } catch (error) {
    if (lockedId) await session.unlock(jobLock(lockedId));
    if (error instanceof Error && error.message === 'job lock unavailable') return null;
    throw error;
  }
  return claimed;
}

export async function memberScopes(store: Store) {
  return (await store.query(`SELECT DISTINCT workspace_id, user_id FROM (
    SELECT workspace_id, owner_user_id AS user_id FROM workspaces
    UNION ALL
    SELECT workspace_id, user_id FROM browser_jobs
  ) members ORDER BY workspace_id, user_id`)).rows as { workspace_id: string; user_id: string }[];
}

// The caller holds jobLock. Recovery preserves evidence without starting another run.
export async function noteInterruption(store: Store, runId: string) {
  await store.recover(runId);
  await store.transaction(async () => {
    const cancelled = !!(await store.query('SELECT cancel_id FROM runtime_runs WHERE run_id=$1', [runId])).rows[0].cancel_id;
    const requests = (await store.query("UPDATE browser_access_requests SET status=$2,finished_at=now() WHERE run_id=$1 AND status IN ('waiting','active') RETURNING access_id", [runId, cancelled ? 'cancelled' : 'interrupted'])).rows;
    for (const request of requests) await store.event(runId, cancelled ? 'access.cancelled' : 'access.interrupted', { access_id: request.access_id, private_observation: true });
    if (!cancelled) await store.query("UPDATE runtime_runs SET config=config || '{\"stop_reason\":\"worker_interrupted\"}'::jsonb WHERE run_id=$1", [runId]);
    await store.event(runId, 'worker.interrupted', { replayed_actions: 0, reason: 'Worker stopped during execution.' });
  });
  await store.publish(runId);
}

export async function abandonJob(store: Store, jobId: string) {
  const job = (await store.query("SELECT * FROM browser_jobs WHERE job_id=$1 AND status='running'", [jobId])).rows[0];
  if (!job) return;
  await store.withScope({ workspaceId: job.workspace_id, userId: job.user_id, agentId: job.agent_id, projectId: job.project_id, taskId: job.task_id }, async () => {
    if (job.run_id) await noteInterruption(store, job.run_id);
    // Read cancellation in the update so a stop requested during recovery wins.
    await store.query(`UPDATE browser_jobs SET
      status=CASE WHEN cancel_id IS NOT NULL THEN 'cancelled' ELSE 'interrupted' END,
      error=CASE WHEN cancel_id IS NOT NULL THEN $2 ELSE $3 END, finished_at=now()
      WHERE job_id=$1 AND status='running'`, [jobId, CANCELLED, INTERRUPTED]);
  });
}

export async function recoverAbandoned(store: Store) {
  const jobs = (await store.query("SELECT job_id FROM browser_jobs WHERE status='running'")).rows;
  for (const job of jobs) {
    const key = jobLock(job.job_id);
    if (!await store.tryLock(key)) continue;
    try { await abandonJob(store, job.job_id); }
    finally { await store.unlock(key); }
  }
}
