import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from './store.js';
import { openBrowser, browserEndpoint } from './browser-sandbox.js';
import { inferFlow, type Snapshot } from './posthog-flows.js';
import { PostHogClient, openPostHogKey, configuredOrigins, type PostHogConnection } from './posthog-client.js';
import { replayFlow } from './posthog-replay.js';

const shutdown=new AbortController();
for(const signal of ['SIGTERM','SIGINT'] as const)process.on(signal,()=>shutdown.abort());
if(!browserEndpoint())throw new Error('PostHog replays require the isolated browser sandbox.');
const store=await new Store().open();
const knownErrors=new Set(['posthog_vault_unavailable','posthog_host_not_allowed','posthog_access_denied','posthog_rate_limited','posthog_endpoint_unavailable','posthog_request_failed','posthog_response_limit','posthog_recording_format_unsupported','posthog_event_format_unsupported','posthog_analysis_format_unsupported','posthog_event_limit','snapshot_encoding_unsupported','snapshot_source_unsupported','snapshot_source_limit','snapshot_not_ready','snapshot_limit']);
const errorCode=(e:unknown)=>e instanceof Error&&knownErrors.has(e.message)?e.message:'posthog_sync_failed';

async function importConnection(c:PostHogConnection){
  const client=new PostHogClient(c,openPostHogKey(c));
  const now=new Date();
  const scan=c.scan??{from:new Date(c.last_synced_at?c.last_synced_at.getTime()-86400000:now.getTime()-7*86400000).toISOString(),to:now.toISOString(),offset:0};
  if(!c.scan)await store.query('UPDATE posthog_connections SET scan=$2 WHERE connection_id=$1',[c.connection_id,JSON.stringify(scan)]);
  const page=await client.recordings(scan);
  let retry:string|null=null;
  for(const recording of page.results){
    if(shutdown.signal.aborted)break;
    const stillActive=await store.query('SELECT enabled FROM posthog_connections WHERE connection_id=$1',[c.connection_id]);
    if(!stillActive.rows[0]?.enabled)return;
    const sessionId=recording.id;
    if(typeof sessionId!=='string'||!/^[\w-]{1,100}$/.test(sessionId))throw new Error('posthog_recording_format_unsupported');
    const previous=(await store.query('SELECT ongoing,workflow_id,imported_at FROM posthog_sessions WHERE connection_id=$1 AND session_id=$2',[c.connection_id,sessionId])).rows[0];
    if(previous&&!previous.ongoing&&previous.workflow_id&&now.getTime()-previous.imported_at.getTime()<600000)continue;
    try{
      const events=await client.events(sessionId);
      // A PostHog session may span subdomains. Each connector only sees its exact source.
      if(!events.length||events.some(e=>e.properties.spekios_synthetic===true))continue;
      let snapshots:Snapshot[]=[],snapshotStatus='available';
      try{snapshots=await client.snapshots(sessionId);}catch(e){snapshotStatus=errorCode(e);}
      const flow=inferFlow(events,snapshots,c.source_origin);
      if(flow.synthetic)continue;
      // Allow out-of-order ingestion to settle before automatically dispatching
      // a supposedly complete journey. The next scan re-imports active sessions.
      const ended=recording.ongoing===false||events.some(e=>e.event==='spekios_session_complete');
      const ongoing=!ended||events.some(e=>Date.parse(e.timestamp)>now.getTime()-60000);
      const started=recording.start_time??events[0].timestamp;
      if(!Number.isFinite(Date.parse(started)))throw new Error('posthog_recording_format_unsupported');
      await store.transaction(async()=>{
        const id=(await store.query('INSERT INTO posthog_workflows(workflow_id,connection_id,fingerprint,title,steps,issues,executable) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(connection_id,fingerprint) DO UPDATE SET updated_at=now() RETURNING workflow_id',[randomUUID(),c.connection_id,flow.fingerprint,flow.title,JSON.stringify(flow.steps),JSON.stringify(flow.issues),flow.executable])).rows[0].workflow_id;
        await store.query('INSERT INTO posthog_sessions(connection_id,session_id,workflow_id,started_at,ongoing,event_count,snapshot_status,issues) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(connection_id,session_id) DO UPDATE SET workflow_id=EXCLUDED.workflow_id,ongoing=EXCLUDED.ongoing,event_count=EXCLUDED.event_count,snapshot_status=EXCLUDED.snapshot_status,issues=EXCLUDED.issues,imported_at=now()',[c.connection_id,sessionId,id,started,ongoing,events.length,snapshotStatus,JSON.stringify(flow.issues)]);
        if(!ongoing&&flow.executable&&c.auto_replay&&configuredOrigins('SCOUT_POSTHOG_REPLAY_ORIGINS').has(c.replay_origin)){
          await store.query('INSERT INTO posthog_replays(replay_id,connection_id,workflow_id,automatic,steps) VALUES($1,$2,$3,true,$4) ON CONFLICT DO NOTHING',[randomUUID(),c.connection_id,id,JSON.stringify(flow.steps)]);
        }
      });
    }catch(error){
      const started=recording.start_time;
      if(!Number.isFinite(Date.parse(started)))throw error;
      const code=errorCode(error);
      await store.query('INSERT INTO posthog_sessions(connection_id,session_id,started_at,ongoing,event_count,snapshot_status,issues) VALUES($1,$2,$3,true,0,\'import_failed\',$4) ON CONFLICT(connection_id,session_id) DO UPDATE SET issues=EXCLUDED.issues,snapshot_status=EXCLUDED.snapshot_status,imported_at=now()',[c.connection_id,sessionId,started,JSON.stringify([code])]);
      if(['posthog_rate_limited','posthog_request_failed','posthog_sync_failed','posthog_access_denied'].includes(code)){retry=code;break;}
    }
  }
  if(shutdown.signal.aborted)return;
  if(retry)throw new Error(retry); // Keep the current page, including older backfill sessions.
  // Fixed scan window and persisted pagination survive restarts. Do not follow
  // upstream `next` URLs with credentials or silently skip a bounded page.
  const more=page.has_next===true||Boolean(page.next)||(page.has_next===undefined&&page.next===undefined&&page.results.length===5);
  if(more&&(!page.results.length||scan.offset>=100000||page.next_cursor&&page.next_cursor===scan.cursor))throw new Error('posthog_recording_format_unsupported');
  await store.query('UPDATE posthog_connections SET scan=$2,last_synced_at=CASE WHEN $2::jsonb IS NULL THEN $3::timestamptz ELSE last_synced_at END,next_sync_at=now()+CASE WHEN $2::jsonb IS NULL THEN interval \'60 seconds\' ELSE interval \'2 seconds\' END,error=NULL WHERE connection_id=$1',[c.connection_id,more?JSON.stringify({...scan,offset:scan.offset+page.results.length,cursor:page.next_cursor}):null,scan.to]);
}

async function runReplay(){
  const row=(await store.query("SELECT r.*,c.replay_origin,c.enabled FROM posthog_replays r JOIN posthog_connections c USING(connection_id) WHERE r.status='queued' ORDER BY r.created_at LIMIT 1")).rows[0];
  if(!row)return;
  if(!row.enabled||!configuredOrigins('SCOUT_POSTHOG_REPLAY_ORIGINS').has(row.replay_origin)){
    await store.query("UPDATE posthog_replays SET status='blocked',result=$2,finished_at=now() WHERE replay_id=$1",[row.replay_id,JSON.stringify({error:'posthog_replay_origin_not_allowed'})]);return;
  }
  await store.query("UPDATE posthog_replays SET status='running' WHERE replay_id=$1",[row.replay_id]);
  const signal=AbortSignal.any([shutdown.signal,AbortSignal.timeout(120000)]);
  try{
    const opened=await openBrowser(store,signal);
    try{
      const result=await replayFlow(opened.browser,row.replay_origin,row.steps,async()=>{
        const c=(await store.pool.query('SELECT enabled FROM posthog_connections WHERE connection_id=$1',[row.connection_id])).rows[0];
        return c?.enabled===true&&configuredOrigins('SCOUT_POSTHOG_REPLAY_ORIGINS').has(row.replay_origin);
      },signal);
      await store.query('UPDATE posthog_replays SET status=$2,result=$3,finished_at=now() WHERE replay_id=$1',[row.replay_id,result.status,JSON.stringify(result)]);
    }finally{await opened.browser.close().catch(()=>{});await opened.release();}
  }catch{
    await store.query("UPDATE posthog_replays SET status='interrupted',result=$2,finished_at=now() WHERE replay_id=$1",[row.replay_id,JSON.stringify({error:'browser_unavailable_or_interrupted'})]);
  }
}

let heartbeat:NodeJS.Timeout|undefined;
try{
  // One importer/replayer owns this lock. An uncertain browser action is never
  // automatically re-dispatched after its process dies.
  while(!await store.tryLock('posthog-worker-v1'))await delay(2000,undefined,{signal:shutdown.signal});
  const report=()=>store.pool.query("INSERT INTO posthog_worker_status(worker_id) VALUES('importer') ON CONFLICT(worker_id) DO UPDATE SET heartbeat_at=now()").catch(()=>{});
  await report();heartbeat=setInterval(()=>void report(),20000);heartbeat.unref();
  await store.query("UPDATE posthog_replays SET status='interrupted',result=$1,finished_at=now() WHERE status='running'",[JSON.stringify({error:'worker_restarted_after_dispatch'})]);
  while(!shutdown.signal.aborted){
    try{
      // Analytics stays independent from recording availability or replay format errors.
      const analyses=(await store.query('SELECT * FROM posthog_connections WHERE enabled AND next_analysis_at<=now() ORDER BY next_analysis_at LIMIT 2')).rows as PostHogConnection[];
      for(const c of analyses){
        try{
          const analysis=await new PostHogClient(c,openPostHogKey(c)).analysis();
          await store.query("UPDATE posthog_connections SET analysis=$2,analysis_updated_at=now(),analysis_error=NULL,next_analysis_at=now()+interval '5 minutes' WHERE connection_id=$1",[c.connection_id,JSON.stringify(analysis)]);
        }catch(e){await store.query("UPDATE posthog_connections SET analysis_error=$2,next_analysis_at=now()+interval '60 seconds' WHERE connection_id=$1",[c.connection_id,errorCode(e)]);}
      }
      const connections=(await store.query('SELECT * FROM posthog_connections WHERE enabled AND next_sync_at<=now() ORDER BY next_sync_at LIMIT 2')).rows as PostHogConnection[];
      for(const c of connections){
        try{await importConnection(c);}catch(e){await store.query("UPDATE posthog_connections SET error=$2,next_sync_at=now()+interval '60 seconds' WHERE connection_id=$1",[c.connection_id,errorCode(e)]);}
      }
      if(!shutdown.signal.aborted)await runReplay();
    }catch{ /* Database recovery is retried; never log upstream data or secrets. */ }
    await delay(2000,undefined,{signal:shutdown.signal}).catch(()=>{});
  }
}finally{if(heartbeat)clearInterval(heartbeat);await store.close();}
