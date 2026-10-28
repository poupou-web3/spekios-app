import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { spawn } from 'node:child_process';
import { root, postgres, sqlString, clients, getObject, sha256 } from './local-clients.mjs';

const env=parseEnv(await readFile(new URL('../.env',import.meta.url),'utf8'));
const request=(path,body,authenticated=true)=>fetch('http://127.0.0.1:18080'+path,{
  method:body?'POST':'GET',headers:{...(authenticated?{Authorization:`Bearer ${env.SCOUT_API_TOKEN}`} : {}),'Content-Type':'application/json'},
  body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(15000),
});
const get=async path=>{const r=await request(path);assert.equal(r.status,200,path);return r.json();};
async function until(check,label,timeout=60000){
  const end=Date.now()+timeout;
  while(Date.now()<end){const result=await check();if(result)return result;await new Promise(r=>setTimeout(r,100));}
  throw new Error('Timed out: '+label);
}
const report=id=>get('/v1/runs/'+id);
const job=async id=>(await get('/v1/browser-jobs')).jobs.find(j=>j.job_id===id);
const done=id=>until(async()=>{const j=await job(id);return j&&!['queued','running'].includes(j.status)&&j;},'job '+id);
const launch=async(path,automatic=false,extra={})=>{
  const jobId=randomUUID(),r=await request('/v1/browser-jobs',{job_id:jobId,kind:'explore',target_url:'http://exploration-fixture:8082'+path,auto_reproduce:automatic,...extra});
  assert.equal(r.status,202,await r.clone().text());return jobId;
};
const linked=id=>until(async()=>{const j=await job(id);return j?.run_id&&j;},'run linked');
const task=id=>until(async()=>{const r=await report(id);return r.automatic_reproductions.find(t=>t.child_job_id);},'automatic child admission');
const stopBatch=async id=>{
  const r=await request(`/v1/runs/${id}/automatic-reproductions/cancel`,{});assert.ok([200,202].includes(r.status),await r.clone().text());return r.json();
};
const docker=args=>new Promise((resolve,reject)=>{
  const p=spawn('docker',['compose',...args],{cwd:root,stdio:['ignore','ignore','inherit']});
  p.on('error',reject);p.on('close',code=>code===0?resolve():reject(new Error('Automatic reproduction test operation failed.')));
});
const childCount=id=>postgres(`SELECT count(*) FROM browser_jobs WHERE automatic_source_action_id=${sqlString(id)};`);
const checks=[],runs={},children={};
assert.equal((await get('/v1/model-providers')).test_mode,true,'Requires simulated providers.');
await until(async()=>(await get('/v1/browser-jobs')).workers.some(w=>w.available),'browser worker');

const unknown=randomUUID();
assert.equal((await request(`/v1/runs/${unknown}/automatic-reproductions/cancel`,{},false)).status,401);
assert.equal((await request(`/v1/runs/${unknown}/automatic-reproductions/cancel`,{})).status,404);
for(const auto_reproduce of ['true',1,null]){
  // Optional null is accepted as omission by serde; all actual values must be booleans.
  if(auto_reproduce===null)continue;
  assert.equal((await request('/v1/browser-jobs',{job_id:randomUUID(),kind:'explore',target_url:'http://exploration-fixture:8082/working',auto_reproduce})).status,400);
}
assert.equal((await request('/v1/browser-jobs',{job_id:randomUUID(),kind:'reproduce',source_action_id:randomUUID(),auto_reproduce:true})).status,400);
assert.equal((await request('/v1/browser-jobs',{job_id:randomUUID(),kind:'explore',target_url:'http://exploration-fixture:8082/working',max_auto_reproductions:100})).status,400);

const optOutId=await launch('/broken-session');
const optOut=await done(optOutId);runs.opt_out=optOut.run_id;
const optOutReport=await report(optOut.run_id);
assert.equal(optOutReport.run.config.automatic_reproduction_policy.enabled,false);
assert.deepEqual(optOutReport.automatic_reproductions,[]);
assert.equal((await request(`/v1/runs/${optOut.run_id}/automatic-reproductions/cancel`,{})).status,409);
checks.push('strict_opt_in_and_bounded_admission','opt_out_has_no_automatic_work');

// A newer ordinary job waits ahead of the generated child. Restart the worker
// while that job runs: the admitted child must survive exactly once.
const automaticId=await launch('/broken-session',true,{viewport_profile:'mobile'});
const blockerId=await launch('/slow-navigation');
const automatic=await done(automaticId);runs.automatic=automatic.run_id;
const automaticTask=await task(automatic.run_id);children.automatic=automaticTask.child_job_id;
await until(async()=>(await job(blockerId))?.status==='running','ordinary job ahead of child');
const queuedChild=await job(automaticTask.child_job_id);assert.equal(queuedChild.status,'queued');
const before=await report(automatic.run_id),sourceAction=before.actions.find(a=>a.action_id===automaticTask.source_action_id);
const manifestClient=(await clients()).s3;
let originalManifest;
try{originalManifest=await getObject(manifestClient,before.run.manifest_key);}finally{manifestClient.destroy();}
const manual={job_id:randomUUID(),kind:'reproduce',source_action_id:automaticTask.source_action_id};
for(const body of [manual,{...manual,job_id:queuedChild.job_id}]){
  const r=await request('/v1/browser-jobs',body);assert.equal(r.status,200,await r.clone().text());
  const result=await r.json();assert.equal(result.reused,true);assert.equal(result.job.job_id,queuedChild.job_id);
}
await docker(['kill','-s','SIGKILL','browser-worker']);await docker(['start','browser-worker']);
assert.equal((await done(blockerId)).status,'interrupted');
const completed=await done(queuedChild.job_id);assert.equal(completed.status,'completed',completed.error);
children.completed_run=completed.run_id;
const sourceAfter=await report(automatic.run_id),replay=await report(completed.run_id);
assert.equal(await childCount(automaticTask.source_action_id),'1');
assert.equal(replay.reproductions[0].result.outcome,'reproduced');
assert.equal(replay.reproductions[0].result.confirmed_bug,false);
assert.equal(replay.run.config.viewport_profile,'mobile');
assert.equal(replay.run.config.automatic_reproduction_policy.enabled,false);
assert.equal(replay.run.config.execution_mode,'protocol_fixture');
assert.equal(replay.run.config.training_status,'excluded_fixture');
assert.equal(Number(replay.model_usage.attempts),2);
assert.equal(Number(replay.model_usage.known_input_tokens),6);
assert.equal(sourceAfter.automatic_reproductions[0].child_job.run_id,replay.run.run_id);
assert.equal(replay.automatic_reproductions[0].source_run_id,automatic.run_id);
assert.deepEqual(sourceAfter.actions,before.actions);assert.deepEqual(sourceAfter.run.config,before.run.config);
assert.deepEqual(sourceAfter.finding_reviews,[]);
assert.equal(await postgres(`SELECT count(*) FROM browser_jobs WHERE parent_job_id=${sqlString(queuedChild.job_id)};`),'0');
checks.push('durable_queued_check_across_restart','manual_and_automatic_replay_share_one_job','one_fresh_replay_and_no_recursion','source_viewport_mode_usage_and_fixture_exclusion','source_evidence_and_ai_verdict_preserved');
console.log('PASS automatic replay, restart, manual deduplication and evidence lineage');

// Cancel queued automatic checks without cancelling the unrelated manual job.
const stopId=await launch('/broken-session',true),stopBlockerId=await launch('/slow-navigation');
const stopSource=await done(stopId);runs.queued_stop=stopSource.run_id;
const stopTask=await task(stopSource.run_id);
await until(async()=>(await job(stopBlockerId))?.status==='running','second blocker');
const unrelatedId=randomUUID(),unrelatedResponse=await request('/v1/browser-jobs',{job_id:unrelatedId,kind:'reproduce',source_action_id:optOutReport.actions[1].action_id});
assert.equal(unrelatedResponse.status,202);
const stop=await stopBatch(stopSource.run_id);
assert.equal((await stopBatch(stopSource.run_id)).cancellation_id,stop.cancellation_id);
assert.equal((await done(stopTask.child_job_id)).status,'cancelled');
assert.equal((await job(stopTask.child_job_id)).run_id,null);
assert.equal((await job(unrelatedId)).status,'queued');
assert.equal((await request(`/v1/browser-jobs/${stopBlockerId}/cancel`,{})).status,202);
await done(stopBlockerId);
assert.equal((await done(unrelatedId)).status,'completed');
assert.equal(await childCount(stopTask.source_action_id),'1');
const stoppedSource=await report(stopSource.run_id);
assert.equal(stoppedSource.run.lifecycle,'completed');assert.ok(stoppedSource.run.auto_reproduction_cancel_id);
assert.equal(stoppedSource.events.filter(e=>e.event_type==='auto_reproduction.cancel_requested').length,1);
checks.push('post_exploration_batch_stop_is_idempotent','unrelated_manual_job_not_cancelled','cancelled_child_not_replaced');

// Stop future checks while ordinary exploration is still running.
const earlyId=await launch('/broken-session?case:delayed',true);
const early=await linked(earlyId);runs.early_stop=early.run_id;
await stopBatch(early.run_id);
assert.equal((await done(earlyId)).status,'completed');
const earlyReport=await report(early.run_id);
assert.deepEqual(earlyReport.automatic_reproductions,[]);
assert.ok(earlyReport.actions.some(a=>a.assessment?.verdict==='suspect'));
checks.push('stopping_future_checks_preserves_active_exploration');

// Parent and active-child stop intents must commit together. Pause only after
// the child's assessment request is dispatched, outside recorder transactions.
const activeId=await launch('/broken-session?case:delayed',true);
const active=await done(activeId);runs.active_stop=active.run_id;
const activeTask=await task(active.run_id);children.active_stop=activeTask.child_job_id;
const activeChild=await until(async()=>{
  const j=await job(activeTask.child_job_id);if(!j?.run_id)return null;
  const r=await report(j.run_id);return r.graph?.decisions.some(d=>d.kind==='assessment'&&d.status==='requested')&&r.model_requests.some(m=>m.state==='dispatched')&&j;
},'active automatic assessment');
await docker(['pause','browser-worker']);
try{
  const operation=await stopBatch(active.run_id);
  const child=await job(activeTask.child_job_id),r=await report(activeChild.run_id);
  assert.ok(child.cancel_id);assert.equal(r.run.cancel_id,child.cancel_id);
  assert.equal(operation.status,'cancelling');
  await docker(['restart','api']);
  await until(async()=>{try{return (await get('/v1/model-providers')).gateway_ready;}catch{return false;}},'API ready after restart');
  assert.equal((await stopBatch(active.run_id)).cancellation_id,operation.cancellation_id);
  assert.equal((await report(activeChild.run_id)).run.cancel_id,child.cancel_id);
}finally{await docker(['unpause','browser-worker']);}
assert.equal((await done(activeTask.child_job_id)).status,'cancelled');
const activeFinal=await report(activeChild.run_id);
assert.equal(activeFinal.run.lifecycle,'cancelled');
assert.equal(activeFinal.reproductions[0].result.outcome,'inconclusive');
checks.push('atomic_parent_and_active_child_stop_intent','batch_cancel_survives_api_restart','cancelled_replay_stays_inconclusive');
console.log('PASS queued, future and active automatic-check cancellation');

// An interrupted check is recorded once, never automatically replayed.
const interruptedId=await launch('/broken-session?case:delayed',true);
const interrupted=await done(interruptedId);runs.interrupted=interrupted.run_id;
const interruptedTask=await task(interrupted.run_id);children.interrupted=interruptedTask.child_job_id;
const dispatched=await until(async()=>{
  const j=await job(interruptedTask.child_job_id);if(!j?.run_id)return null;
  const r=await report(j.run_id);return r.actions.some(a=>a.dispatched_at&&!a.finished_at)&&{job:j,report:r};
},'automatic check dispatch');
await docker(['kill','-s','SIGKILL','browser-worker']);await docker(['start','browser-worker']);
assert.equal((await done(interruptedTask.child_job_id)).status,'interrupted');
const recovered=await report(dispatched.job.run_id);
assert.equal(recovered.run.lifecycle,'failed');
assert.equal(recovered.actions.length,dispatched.report.actions.length);
assert.equal(recovered.model_requests.length,dispatched.report.model_requests.length);
assert.equal(recovered.reproductions[0].result.outcome,'inconclusive');
await until(async()=>(await report(dispatched.job.run_id)).model_requests.every(m=>!['queued','preparing','dispatched'].includes(m.state)),'late provider settlement');
assert.equal(await childCount(interruptedTask.source_action_id),'1');
checks.push('interrupted_automatic_check_never_retried');

const {s3,clickhouse}=await clients();
try{
  const unchanged=await report(automatic.run_id);
  assert.equal(unchanged.run.manifest_key,before.run.manifest_key);
  assert.equal(sha256(await getObject(s3,unchanged.run.manifest_key)),sha256(originalManifest));
  for(const capture of replay.captures)assert.equal(sha256(await getObject(s3,capture.object_key)),capture.sha256);
  await until(async()=>Number((await get('/v1/operations')).pending_runtime_events)===0,'automatic task telemetry');
  const sourceEvents=unchanged.events.filter(e=>e.event_type.startsWith('auto_reproduction.'));
  const exported=Number((await clickhouse(`SELECT count(DISTINCT event_id) FROM scout.runtime_events WHERE run_id=${sqlString(automatic.run_id)} AND event_type LIKE 'auto_reproduction.%' FORMAT TabSeparated`)).trim());
  assert.equal(exported,sourceEvents.length);
}finally{s3.destroy();}
checks.push('immutable_manifests_and_replay_png_hashes','clickhouse_automatic_task_events');
const result={status:'passed',verified_at:new Date().toISOString(),mode:'simulated_models_real_browser_worker',runs,children,checks,visual_check:'unverified'};
await mkdir(new URL('../artifacts/automatic-reproduction/',import.meta.url),{recursive:true});
await writeFile(new URL('../artifacts/automatic-reproduction/verification.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
