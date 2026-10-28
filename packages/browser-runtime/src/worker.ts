import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from './store.js';
import { workspaceId, userId } from './contracts.js';
import { explore, reproduce } from './explorer.js';
import { ModelClient } from './model-client.js';
import { AccessHandoff } from './access-handoff.js';
import { AutomaticReproductionScheduler, type GatewayStatus } from './automatic-reproduction.js';

const store = await new Store().open();
const lease = await store.pool.connect();
const workerId = randomUUID();
const access=new AccessHandoff(store);
const automatic=new AutomaticReproductionScheduler(store);
let stopping = false, heartbeat: ReturnType<typeof setInterval> | undefined;
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });
// The session lock prevents two daemons from recovering/claiming each other's jobs.
const locked = (await lease.query("SELECT pg_try_advisory_lock(hashtextextended('scout-browser-worker-v1',0)) AS acquired")).rows[0].acquired;
if (!locked) throw new Error('Another browser worker is already running.');

async function mode() {
  const response = await fetch((process.env.SCOUT_API_URL ?? 'http://api:8080') + '/v1/model-providers', {
    headers: { Authorization: `Bearer ${process.env.SCOUT_API_TOKEN ?? ''}` }, signal: AbortSignal.timeout(5000), redirect: 'error',
  });
  if (!response.ok) throw new Error('Model gateway is unavailable.');
  const data = await response.json();
  if (!data.gateway_ready) throw new Error('Model gateway is recovering.');
  return {executionMode:data.test_mode?'protocol_fixture':'live',configuredProviders:(data.providers??[]).filter((p:any)=>p.configured).map((p:any)=>p.provider)} as GatewayStatus;
}
async function interrupted(runId:string|null) {
  if(!runId)return;
  // Playwright may close the browser on SIGTERM before Docker kills the
  // process. That can finish the run's evidence-failure path during shutdown;
  // it is still an interrupted job, never a reason to dispatch it again.
  await store.recover(runId);
  await store.transaction(async()=>{
    const cancelled=!!(await store.query('SELECT cancel_id FROM runtime_runs WHERE run_id=$1',[runId])).rows[0].cancel_id;
    const requests=(await store.query("UPDATE browser_access_requests SET status=$2,finished_at=now() WHERE run_id=$1 AND status IN ('waiting','active') RETURNING access_id",[runId,cancelled?'cancelled':'interrupted'])).rows;
    for(const request of requests)await store.event(runId,cancelled?'access.cancelled':'access.interrupted',{access_id:request.access_id,private_observation:true});
    if(!cancelled)await store.query("UPDATE runtime_runs SET config=config || '{\"stop_reason\":\"worker_interrupted\"}'::jsonb WHERE run_id=$1",[runId]);
    await store.event(runId,'worker.interrupted',{replayed_actions:0,reason:'Worker stopped during execution.'});
  });
  await store.publish(runId);
}
try {
  await access.listen();
  await access.vault.purge();
  await lease.query("INSERT INTO browser_workers(worker_id,workspace_id,status) VALUES($1,$2,'online')", [workerId, workspaceId]);
  heartbeat = setInterval(() => {
    void lease.query('UPDATE browser_workers SET heartbeat_at=now() WHERE worker_id=$1', [workerId]).catch(() => { stopping = true; });
  }, 5000);
  let recovered = false,nextExportAt=0;
  while (!stopping) {
    // Human reviews can append events after a run finishes. Export a bounded
    // batch while idle even when inference is unavailable; a ClickHouse outage
    // retains the outbox without restarting or replaying browser work.
    if(Date.now()>=nextExportAt){
      nextExportAt=Date.now()+2000;
      try{
        const pending=(await store.query('SELECT 1 FROM runtime_events WHERE exported_at IS NULL LIMIT 1')).rowCount;
        if(pending)await store.exclusive(()=>store.flush(undefined,1));
      }catch{/* The next maintenance pass retries the durable outbox. */}
    }
    try {
      let gateway:GatewayStatus|null=null;
      try{gateway=await mode();}catch{/* Durable automatic tasks remain pending without inference. */}
      const executionMode=gateway?.executionMode;
      // Recorder locks also serialize this worker with CLI runs and recovery.
      await store.exclusive(async () => {
        if (!recovered) {
          const abandoned = (await store.query("SELECT job_id,run_id,cancel_id FROM browser_jobs WHERE workspace_id=$1 AND user_id=$2 AND status='running'", [workspaceId, userId])).rows;
          for (const job of abandoned) {
            if(job.run_id)await store.transaction(async()=>{
              const requests=(await store.query("UPDATE browser_access_requests SET status=$2,finished_at=now() WHERE run_id=$1 AND status IN ('waiting','active') RETURNING access_id",[job.run_id,job.cancel_id?'cancelled':'interrupted'])).rows;
              for(const request of requests)await store.event(job.run_id,job.cancel_id?'access.cancelled':'access.interrupted',{access_id:request.access_id,private_observation:true});
            });
            if (job.run_id) await store.recover(job.run_id);
            await store.query("UPDATE browser_jobs SET status=CASE WHEN cancel_id IS NOT NULL THEN 'cancelled' ELSE 'interrupted' END,error='Worker stopped during execution. No browser action was repeated.',finished_at=now() WHERE job_id=$1", [job.job_id]);
          }
          // Recovery can append events even when no next job is queued. Drain
          // them before entering the idle loop so ClickHouse receives the trail.
          await store.flush();
          recovered = true;
        }
        await automatic.sweep(gateway);
        if(!executionMode)return;
        const job = (await store.query(`UPDATE browser_jobs SET status='running',worker_id=$3,started_at=now()
          WHERE status='queued' AND job_id=(SELECT job_id FROM browser_jobs WHERE workspace_id=$1 AND user_id=$2 AND status='queued' AND next_attempt_at<=now() AND execution_mode=$4
            AND (automatic_source_action_id IS NULL OR settings->>'provider'=ANY($5::text[])) ORDER BY created_at LIMIT 1)
          RETURNING *`, [workspaceId, userId, workerId, executionMode,gateway?.configuredProviders??[]])).rows[0];
        if (!job) return;
        try {
          if(!await automatic.beforeDispatch(job,gateway))return;
          const currentOrigins = (process.env.SCOUT_ALLOWED_ORIGINS ?? 'http://exploration-fixture:8082').split(',').map(s => s.trim());
          const options = { client: new ModelClient(job.settings), maxActions: job.settings.maxActions,
            allowedOrigins: job.settings.allowedOrigins.filter((origin: string) => currentOrigins.includes(origin)), jobId: job.job_id,
            autoReproduce:job.settings.autoReproduce,maxAutoReproductions:job.settings.maxAutoReproductions,maxAutoReplayActions:job.settings.maxAutoReplayActions,
            viewportProfile: job.settings.viewportProfile,access,authMode:job.request.auth_mode??'auto',sessionId:job.request.session_id };
          const result = job.request.kind === 'reproduce'
            ? await reproduce(store, job.request.source_action_id, options)
            : await explore(store, job.request.target_url, options);
          const failure = result.report.run.error ?? result.manifest_error ?? result.export_error;
          const wasInterrupted=stopping&&result.report.run.lifecycle==='failed';
          if(wasInterrupted)await interrupted(result.run_id);
          await store.query("UPDATE browser_jobs SET status=CASE WHEN cancel_id IS NOT NULL THEN 'cancelled' ELSE $2 END,run_id=$3,error=$4,finished_at=now() WHERE job_id=$1 AND worker_id=$5",
            [job.job_id, wasInterrupted?'interrupted':['blocked','cancelled'].includes(result.report.run.lifecycle)?result.report.run.lifecycle:result.report.run.lifecycle === 'completed' && !failure ? 'completed' : 'failed', result.run_id,
              wasInterrupted?'Worker stopped during execution. No browser action was repeated.':failure, workerId]);
        } catch {
          // Detailed execution errors already live on the run. Avoid logging
          // arbitrary target/provider text or credentials to process output.
          const linked = (await store.query('SELECT run_id FROM browser_jobs WHERE job_id=$1', [job.job_id])).rows[0];
          if(stopping)await interrupted(linked.run_id);
          else if (linked.run_id) await store.recover(linked.run_id);
          await store.query("UPDATE browser_jobs SET status=CASE WHEN cancel_id IS NOT NULL THEN 'cancelled' ELSE $3 END,error=$4,finished_at=now() WHERE job_id=$1 AND worker_id=$2", [job.job_id, workerId,
            stopping?'interrupted':'failed',stopping?'Worker stopped during execution. No browser action was repeated.':'Execution could not finish. Inspect the run evidence and provider settings.']);
        }
        await store.flush();
      });
    } catch {
      recovered = false;
      // A lock holder, unavailable dependency or failed recovery is retried;
      // a running job is never dispatched again.
    }
    if (!stopping) await delay(1000);
  }
} finally {
  clearInterval(heartbeat);
  await access.close();
  await lease.query("UPDATE browser_workers SET status='stopped',heartbeat_at=now() WHERE worker_id=$1", [workerId]).catch(() => {});
  lease.release();
  await store.close();
}
