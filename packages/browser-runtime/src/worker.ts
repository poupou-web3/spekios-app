import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from './store.js';
import { workspaceId } from './contracts.js';
import { explore, reproduce, verifyFix } from './explorer.js';
import { ModelClient } from './model-client.js';
import { AccessHandoff } from './access-handoff.js';
import { AutomaticReproductionScheduler, type GatewayStatus } from './automatic-reproduction.js';
import { browserEndpoint, browserSlots } from './browser-sandbox.js';
import { abandonJob, claimJob, dispatchedCount, jobLock, memberScopes, recoverAbandoned, resumeBudget, runIdList } from './job-queue.js';
import { enableProcessLog, log } from './log.js';

// Target sites never run beside the credentials and saved logins this worker holds.
if (!browserEndpoint()) throw new Error('The browser worker needs SCOUT_BROWSER_ENDPOINT so target sites run in the browser sandbox.');
const slots = browserSlots();
enableProcessLog();
const store = await new Store().open();
const lease = await store.pool.connect();
const workerId = randomUUID();
const access = new AccessHandoff(store);
const shutdown = new AbortController();
let stopping = false, heartbeat: ReturnType<typeof setInterval> | undefined;
const stop = () => { if (!stopping) log('info', 'worker_stopping', { worker_id: workerId }); stopping = true; shutdown.abort(); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

async function mode() {
  const response = await fetch((process.env.SCOUT_API_URL ?? 'http://api:8080') + '/v1/model-providers', {
    headers: { Authorization: `Bearer ${process.env.SCOUT_API_TOKEN ?? ''}` }, signal: AbortSignal.timeout(5000), redirect: 'error',
  });
  if (!response.ok) throw new Error('Model gateway is unavailable.');
  const data = await response.json();
  if (!data.gateway_ready) throw new Error('Model gateway is recovering.');
  return { executionMode: data.test_mode ? 'protocol_fixture' : 'live', configuredProviders: (data.providers ?? []).filter((p: any) => p.configured).map((p: any) => p.provider) } as GatewayStatus;
}

// The cheaper model for navigation actions, when its provider is configured.
// Otherwise the main model handles everything, as before.
function navigationClient(settings: Record<string, any>, gateway: GatewayStatus) {
  const nav = settings.navigationModel;
  if (!nav || !gateway.configuredProviders.includes(nav.provider)) return null;
  return new ModelClient({ provider: nav.provider, model: nav.model, freeOnly: settings.freeOnly === true && nav.provider === 'openrouter', providerKeyId:nav.providerKeyId??(nav.provider===settings.provider?settings.providerKeyId:null) });
}

async function run(session: Store, job: Record<string, any>, gateway: GatewayStatus) {
  const key = jobLock(job.job_id), started = Date.now();
  const done = async (fallback: string) => {
    const row = (await session.query('SELECT status,run_id FROM browser_jobs WHERE job_id=$1', [job.job_id]).catch(() => ({ rows: [] }))).rows[0];
    const status = row?.status ?? fallback;
    log(['failed', 'interrupted', 'blocked'].includes(status) ? 'warning' : 'info', 'job_finished', { job_id: job.job_id, run_id: row?.run_id, status, elapsed_ms: Date.now() - started });
  };
  log('info', 'job_started', { job_id: job.job_id, kind: job.request?.kind, execution_mode: gateway.executionMode, provider: job.settings?.provider, model: job.settings?.model, worker_id: workerId });
  try {
    await session.withScope({ workspaceId: job.workspace_id, userId: job.user_id, agentId: job.agent_id, projectId: job.project_id, taskId: job.task_id }, async () => {
      if (!await new AutomaticReproductionScheduler(session).beforeDispatch(job, gateway)) return;
      const previous = runIdList(job.previous_run_ids);
      // Admission froze the resolved limits; null means none, and a missing key
      // (a job admitted before limits existed) falls back to the server default.
      const limit = (key: string) => key in job.settings ? (job.settings[key] ?? null) as number | null : undefined;
      const budget = limit('maxActions'), minutes = limit('maxMinutes');
      let maxActions = budget;
      let resume: { attempt: number; previousRunIds: string[]; jobMaxActions: number | null; carriedActions: number } | undefined;
      if (previous.length) {
        const carried = await dispatchedCount(session, previous);
        const plan = resumeBudget({ continueFrom: typeof job.request?.continue_from_run_id === 'string', maxActions: budget }, carried);
        if ('stop' in plan) {
          await session.query("UPDATE browser_jobs SET status='interrupted', error=$2, finished_at=now() WHERE job_id=$1 AND status='running' AND worker_id=$3",
            [job.job_id, 'Exploration stopped after its action budget was used. In-flight actions were not repeated.', workerId]);
          return;
        }
        maxActions = plan.maxActions;
        resume = { attempt: Number(job.resumes), previousRunIds: previous, jobMaxActions: budget ?? null, carriedActions: plan.carriedActions };
      }
      try {
        const currentOrigins = (process.env.SCOUT_ALLOWED_ORIGINS ?? 'http://exploration-fixture:8082').split(',').map(s => s.trim());
        const options = { client: new ModelClient(job.settings), maxActions,
          allowedOrigins: job.settings.allowedOrigins.filter((origin: string) => currentOrigins.includes(origin)), jobId: job.job_id,
          autoReproduce: job.settings.autoReproduce, maxAutoReproductions: job.settings.maxAutoReproductions, maxAutoReplayActions: job.settings.maxAutoReplayActions,
          // Jobs admitted before memory existed omit the setting and stay memory-free.
          appMemory: job.settings.appMemory === true,
          viewportProfile: job.settings.viewportProfile, access, authMode: job.request.auth_mode ?? 'auto', sessionId: job.request.session_id,
          maxDurationMs: minutes == null ? minutes : minutes * 60000,
          maxTokens: limit('maxTokens') ?? null, maxCostUsd: limit('maxCostUsd') ?? null, stopAfterIdleActions: limit('stopAfterIdleActions') ?? null,
          // Jobs admitted before strategies existed use the default split.
          strategy: job.settings.explorationStrategy ?? null,
          reuseRankings: job.settings.reuseRankings === true, navigationClient: navigationClient(job.settings, gateway),
          shutdown: shutdown.signal, resume };
        const result = await (job.request.kind === 'verify_fix' ? verifyFix(session, job.job_id, options) : job.request.kind === 'reproduce'
          ? reproduce(session, job.request.source_action_id, options)
          : explore(session, job.request.target_url, options));
        if (stopping && result.report.run.lifecycle === 'failed' && !result.report.run.cancel_id) {
          await abandonJob(session, job.job_id);
          return;
        }
        const failure = result.report.run.error ?? result.manifest_error ?? result.export_error;
        const lifecycle = result.report.run.lifecycle;
        await session.query("UPDATE browser_jobs SET status=CASE WHEN cancel_id IS NOT NULL THEN 'cancelled' ELSE $2 END,run_id=$3,error=$4,finished_at=now() WHERE job_id=$1 AND worker_id=$5 AND status='running'",
          [job.job_id, ['blocked', 'cancelled'].includes(lifecycle) ? lifecycle : lifecycle === 'completed' && !failure ? 'completed' : 'failed', result.run_id, failure, workerId]);
      } catch (error) {
        // Detailed execution errors already live on the run. Avoid logging
        // arbitrary target/provider text or credentials to process output.
        log('error', 'job_execution_failed', { job_id: job.job_id, error_class: error instanceof Error ? error.name : 'unknown' });
        if (stopping) { await abandonJob(session, job.job_id); return; }
        const linked = (await session.query('SELECT run_id FROM browser_jobs WHERE job_id=$1', [job.job_id])).rows[0];
        if (linked.run_id) await session.recover(linked.run_id);
        await session.query("UPDATE browser_jobs SET status=CASE WHEN cancel_id IS NOT NULL THEN 'cancelled' ELSE 'failed' END,error=$3,finished_at=now() WHERE job_id=$1 AND worker_id=$2 AND status='running'",
          [job.job_id, workerId, 'Execution could not finish. Inspect the run evidence and provider settings.']);
      }
      try { await session.flush(); } catch { /* The idle pass retries the durable outbox. */ }
    });
  } finally { await done('unknown').catch(() => {}); await session.unlock(key); }
}

try {
  await access.listen();
  await access.vault.purge();
  await lease.query('INSERT INTO browser_workers(worker_id,workspace_id,status,slots) VALUES($1,$2,\'online\',$3)', [workerId, workspaceId, slots]);
  log('info', 'worker_started', { worker_id: workerId, slots });
  heartbeat = setInterval(() => {
    void lease.query('UPDATE browser_workers SET heartbeat_at=now() WHERE worker_id=$1', [workerId]).catch(() => stop());
  }, 5000);
  const inflight = new Set<Promise<void>>();
  let nextExportAt = 0;
  while (!stopping || inflight.size) {
    if (Date.now() >= nextExportAt) {
      nextExportAt = Date.now() + 2000;
      try {
        const pending = (await store.query('SELECT 1 FROM runtime_events WHERE exported_at IS NULL LIMIT 1')).rowCount;
        if (pending) await store.flush(undefined, 1);
        await store.flushIdentity();
        await store.flushIssues();
      } catch { /* The next maintenance pass retries the durable outbox. */ }
    }
    let gateway: GatewayStatus | null = null;
    try {
      await recoverAbandoned(store);
      try { gateway = await mode(); } catch { /* Durable automatic tasks remain pending without inference. */ }
      for (const member of await memberScopes(store)) {
        await store.withScope({ workspaceId: member.workspace_id, userId: member.user_id }, () => new AutomaticReproductionScheduler(store).sweep(gateway));
      }
      while (!stopping && gateway && inflight.size < slots) {
        const session = await store.session();
        try {
          const job = await claimJob(session, workerId, gateway.executionMode, gateway.configuredProviders, slots);
          if (!job) { await session.close(); break; }
          const slot: { task?: Promise<void> } = {};
          slot.task = run(session, job, gateway).finally(() => { inflight.delete(slot.task!); return session.close(); }).catch(() => {});
          inflight.add(slot.task);
        } catch (error) { await session.close(); throw error; }
      }
    } catch {
      // A lock holder, unavailable dependency or failed recovery is retried;
      // a running job stays claimed until its connection drops.
    }
    if (stopping && inflight.size === 0) break;
    if (!stopping || inflight.size) await delay(stopping ? 200 : 1000);
  }
  await Promise.all(inflight);
} finally {
  clearInterval(heartbeat);
  await access.close();
  await lease.query("UPDATE browser_workers SET status='stopped',heartbeat_at=now() WHERE worker_id=$1", [workerId]).catch(() => {});
  lease.release();
  await store.close();
}
