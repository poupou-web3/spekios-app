import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { spawn } from 'node:child_process';
import { root, postgres, sqlString, clients, getObject, sha256 } from './local-clients.mjs';

const env=parseEnv(await readFile(new URL('../.env',import.meta.url),'utf8'));
const request=(path,body,authenticated=true,extra={})=>fetch('http://127.0.0.1:18080'+path,{
  method:body?'POST':'GET',headers:{...(authenticated?{Authorization:`Bearer ${env.SCOUT_API_TOKEN}`} : {}),'Content-Type':'application/json',...extra},
  body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(15000),
});
const get=async path=>{const response=await request(path);assert.equal(response.status,200,path);return response.json();};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,label,timeout=40000){
  const end=Date.now()+timeout;
  while(Date.now()<end){const result=await check();if(result)return result;await pause(75);}
  throw new Error('Timed out: '+label);
}
const job=async id=>(await get('/v1/browser-jobs')).jobs.find(j=>j.job_id===id);
const report=id=>get('/v1/runs/'+id);
const done=id=>until(async()=>{const j=await job(id);return j&&!['queued','running'].includes(j.status)&&j;},'job completion');
const cancel=async(kind,id)=>{
  const response=await request(`/v1/${kind==='run'?'runs':'browser-jobs'}/${id}/cancel`,{});
  assert.ok([200,202].includes(response.status),await response.clone().text());return response.json();
};
const launch=async path=>{
  const id=randomUUID(),response=await request('/v1/browser-jobs',{job_id:id,kind:'explore',target_url:'http://exploration-fixture:8082'+path});
  assert.equal(response.status,202,await response.clone().text());return id;
};
const linked=id=>until(async()=>{const j=await job(id);return j?.run_id&&j;},'run linked');
const accessFor=id=>until(async()=>(await get('/v1/browser-access')).requests.find(a=>a.job_id===id&&a.status==='waiting'),'private login');
const docker=args=>new Promise((resolve,reject)=>{
  const p=spawn('docker',['compose',...args],{cwd:root,stdio:['ignore','ignore','inherit']});
  p.on('error',reject);p.on('close',code=>code===0?resolve():reject(new Error('Docker cancellation test failed.')));
});
const runs={},checks=[];
assert.equal((await get('/v1/model-providers')).test_mode,true,'Requires simulated models.');

// Auth and ownership are checked before cancellation can mutate anything.
for(const kind of ['runs','browser-jobs']){
  assert.equal((await request(`/v1/${kind}/${randomUUID()}/cancel`,{},false)).status,401);
  assert.equal((await request(`/v1/${kind}/${randomUUID()}/cancel`,{})).status,404);
}
const foreignJob=randomUUID(),foreignRun=randomUUID(),foreignWorkspace=randomUUID();
await postgres(`INSERT INTO runtime_runs(run_id,workspace_id,user_id,target_url,lifecycle,config) VALUES(${sqlString(foreignRun)},${sqlString(foreignWorkspace)},${sqlString(randomUUID())},'http://fixture.invalid/','active','{"runtime_version":"explorer-v1"}');
INSERT INTO browser_jobs(job_id,workspace_id,user_id,request,settings,execution_mode,status) VALUES(${sqlString(foreignJob)},${sqlString(foreignWorkspace)},${sqlString(randomUUID())},'{}','{}','protocol_fixture','queued');`);
try{
  assert.equal((await request(`/v1/runs/${foreignRun}/cancel`,{})).status,404);
  assert.equal((await request(`/v1/browser-jobs/${foreignJob}/cancel`,{})).status,404);
  assert.equal(await postgres(`SELECT count(*) FROM runtime_runs WHERE run_id=${sqlString(foreignRun)} AND cancel_id IS NULL;`),'1');
}finally{await postgres(`DELETE FROM browser_jobs WHERE job_id=${sqlString(foreignJob)};DELETE FROM runtime_runs WHERE run_id=${sqlString(foreignRun)};`);}
checks.push('authentication_and_workspace_ownership');

await docker(['stop','browser-worker']);
const queuedId=await launch('/working');
const queued=await cancel('job',queuedId);
assert.equal(queued.status,'cancelled');assert.ok(queued.cancellation_id);
assert.equal((await cancel('job',queuedId)).cancellation_id,queued.cancellation_id);
assert.equal((await job(queuedId)).run_id,null);
await docker(['start','browser-worker']);
await until(async()=>(await get('/v1/browser-jobs')).workers.some(w=>w.available),'worker ready');
checks.push('queued_cancel_idempotent_without_browser_or_model');
console.log('PASS cancellation auth, ownership and queued jobs');

// Stop while Chromium is awaiting a response. The before screenshot must remain.
const navigationId=await launch('/slow-navigation');
const navigation=await linked(navigationId);runs.navigation=navigation.run_id;
await until(async()=>(await report(navigation.run_id)).actions.some(a=>a.state==='dispatched'),'navigation dispatched');
await pause(250);
const started=Date.now(),navCancel=await cancel('run',navigation.run_id);
assert.equal((await cancel('job',navigationId)).cancellation_id,navCancel.cancellation_id);
assert.equal((await done(navigationId)).status,'cancelled');
const stopLatency=Date.now()-started;
assert.ok(stopLatency<5000,`Slow navigation took ${stopLatency}ms to cancel`);
const navigationReport=await report(navigation.run_id);
assert.equal(navigationReport.run.lifecycle,'cancelled');
assert.equal(navigationReport.run.config.stop_reason,'user_cancelled');
assert.equal(navigationReport.actions.length,1);
assert.equal(navigationReport.actions[0].state,'cancelled');
assert.equal(navigationReport.actions[0].assessment.verdict,'inconclusive');
assert.ok(navigationReport.captures.some(c=>c.phase==='before'&&c.status==='available'));
assert.equal(navigationReport.events.filter(e=>e.event_type==='run.cancel_requested').length,1);
assert.equal(navigationReport.events.filter(e=>e.event_type==='run.cancelled').length,1);
checks.push('active_navigation_interrupted_with_evidence_retained','single_id_across_job_and_run_cancellation');
console.log('PASS active navigation cancellation and retained evidence');

// Cancel after action evidence, while its assessment is in flight. Queue a
// second gateway request behind it to check the actual provider dispatch fence.
const modelId=await launch('/working?case:delayed');
const modelJob=await linked(modelId);runs.model=modelJob.run_id;
const pending=await until(async()=>{
  const r=await report(modelJob.run_id);
  const decision=r.graph?.decisions.find(d=>d.kind==='assessment'&&d.status==='requested');
  if(!decision)return null;
  const response=await request('/v1/model-requests/'+decision.request_id);
  if(response.status===404)return null;
  assert.equal(response.status,200);const detail=await response.json();
  return detail.calls.some(c=>c.state==='dispatched')&&{report:r,detail};
},'assessment in flight');
const extraRequest={request_id:randomUUID(),provider:'openrouter',model:`fixture/${randomUUID()}:free`,prompt:'Inspect queued cancellation fixture.',run_id:modelJob.run_id,max_attempts:1,max_output_tokens:100};
assert.equal((await request('/v1/model-requests',extraRequest)).status,202);
await cancel('run',modelJob.run_id);
assert.equal((await done(modelId)).status,'cancelled');
const cancelledModel=await report(modelJob.run_id);
assert.equal(cancelledModel.actions.length,pending.report.actions.length);
assert.equal(cancelledModel.actions.at(-1).assessment.verdict,'inconclusive');
assert.equal(cancelledModel.actions.at(-1).state,'cancelled');
assert.ok(cancelledModel.actions.at(-1).after_capture_id);
assert.ok(cancelledModel.actions.at(-1).comparison);
assert.equal((await request('/v1/model-requests',{...extraRequest,request_id:randomUUID()})).status,409);
// Re-reading/re-submitting the exact existing request remains idempotent.
assert.equal((await request('/v1/model-requests',extraRequest)).status,200);
const late=await until(async()=>{const r=await get('/v1/model-requests/'+pending.detail.request.request_id);return r.request.state==='completed'&&r;},'late provider settlement');
assert.equal(late.calls.length,1);assert.equal(late.calls[0].usage_status,'reported');
const undispatched=await until(async()=>{const r=await get('/v1/model-requests/'+extraRequest.request_id);return r.request.state==='cancelled'&&r;},'queued provider cancellation');
assert.equal(undispatched.calls.length,0);assert.equal(undispatched.request.attempt_count,0);
assert.ok(undispatched.events.some(e=>e.event_type==='request_cancelled'));
const settledModel=await report(modelJob.run_id);
assert.equal(settledModel.run.lifecycle,'cancelled');
assert.equal(settledModel.model_requests.length,cancelledModel.model_requests.length);
assert.equal(settledModel.actions.length,cancelledModel.actions.length);
assert.equal(Number(settledModel.model_usage.known_input_tokens),6);
checks.push('cancel_assessment_preserves_both_captures_and_comparison','no_new_model_admission','queued_provider_request_never_dispatched','late_usage_and_response_retained');
console.log('PASS model dispatch fences and late token accounting');

const loginId=await launch('/auth/required');
const access=await accessFor(loginId);runs.login=access.run_id;
const opened=await request(`/v1/browser-access/${access.access_id}/start`,{client_id:randomUUID()});
assert.equal(opened.status,200);const {lease}=await opened.json();
const beforeLogin=await report(access.run_id);
await cancel('run',access.run_id);
assert.equal((await done(loginId)).status,'cancelled');
assert.equal((await request(`/v1/browser-access/${access.access_id}/input`,{input_id:randomUUID(),type:'text',value:'must-not-be-typed'},true,{'X-Scout-Access-Lease':lease})).status,404);
assert.equal((await get('/v1/browser-access')).requests.find(a=>a.access_id===access.access_id).status,'cancelled');
const afterLogin=await report(access.run_id);
assert.equal(afterLogin.captures.length,beforeLogin.captures.length);
assert.equal(afterLogin.model_requests.length,beforeLogin.model_requests.length);
assert.ok(!JSON.stringify(afterLogin).includes('PRIVATE_LOGIN_ONLY'));
checks.push('private_login_cancelled_and_lease_invalidated','private_screen_not_recorded');
console.log('PASS private login cancellation');

// The worker is dead when cancellation is requested. API restart must preserve
// the intent, and worker startup must acknowledge it without replaying a click.
const recoveryId=await launch('/auth/required');
const recovery=await accessFor(recoveryId);runs.recovery=recovery.run_id;
const beforeCrash=await report(recovery.run_id);
await docker(['kill','-s','SIGKILL','browser-worker']);
const durable=await cancel('job',recoveryId);
assert.equal(durable.status,'cancelling');
await docker(['restart','api']);
await until(async()=>{try{return (await get('/v1/model-providers')).gateway_ready;}catch{return false;}},'API restart');
assert.equal((await cancel('run',recovery.run_id)).cancellation_id,durable.cancellation_id);
await docker(['start','browser-worker']);
assert.equal((await done(recoveryId)).status,'cancelled');
const recovered=await report(recovery.run_id);
assert.equal(recovered.run.lifecycle,'cancelled');
assert.equal(recovered.run.config.stop_reason,'user_cancelled');
assert.equal(recovered.actions.length,beforeCrash.actions.length);
assert.equal(recovered.model_requests.length,beforeCrash.model_requests.length);
assert.equal((await get('/v1/browser-access')).requests.find(a=>a.access_id===recovery.access_id).status,'cancelled');
checks.push('durable_cancellation_across_api_and_worker_restart','no_action_replay_during_cancel_recovery');
console.log('PASS durable cancellation after worker crash');

// Stopping one run cannot poison later runs, or rewrite already completed work.
const healthyId=await launch('/working');
const healthy=await done(healthyId);runs.subsequent=healthy.run_id;
assert.equal(healthy.status,'completed',healthy.error);
const finished=await report(healthy.run_id);
assert.equal((await cancel('run',healthy.run_id)).status,'already_finished');
assert.equal((await cancel('job',healthyId)).status,'already_finished');
assert.equal((await report(healthy.run_id)).run.cancel_id,null);
assert.ok(finished.actions.every(a=>a.state==='completed'));
assert.equal((await job(queuedId)).run_id,null);
checks.push('subsequent_run_executes_normally','terminal_run_not_rewritten');

const {s3,clickhouse}=await clients();
try{
  for(const id of Object.values(runs)){
    const r=await report(id),manifest=JSON.parse((await getObject(s3,r.run.manifest_key)).toString());
    assert.equal(manifest.run.lifecycle,r.run.lifecycle);
    for(const c of r.captures.filter(c=>c.status==='available'))assert.equal(sha256(await getObject(s3,c.object_key)),c.sha256);
  }
  await until(async()=>Number((await get('/v1/operations')).pending_runtime_events)===0,'runtime event export');
  await until(async()=>Number((await get('/v1/operations')).pending_model_events)===0,'model event export');
  const count=Number((await clickhouse(`SELECT count(DISTINCT event_id) FROM scout.runtime_events WHERE run_id=${sqlString(navigation.run_id)} AND event_type IN ('run.cancel_requested','run.cancelled') FORMAT TabSeparated`)).trim());
  assert.equal(count,2);
}finally{s3.destroy();}
checks.push('cancellation_manifests_and_screenshot_hashes','clickhouse_cancel_event_delivery');
const result={status:'passed',verified_at:new Date().toISOString(),mode:'simulated_models_real_browser_worker',runs,queued_job_id:queuedId,navigation_stop_ms:stopLatency,checks,visual_check:'unverified'};
await mkdir(new URL('../artifacts/cancellation/',import.meta.url),{recursive:true});
await writeFile(new URL('../artifacts/cancellation/verification.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
