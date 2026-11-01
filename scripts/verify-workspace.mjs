import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { sha256, root, postgres, sqlString } from './local-clients.mjs';

const env = parseEnv(await readFile(new URL('../.env', import.meta.url), 'utf8'));
const request = (path, body, authenticated=true) => fetch('http://127.0.0.1:18080'+path, {
  method:body?'POST':'GET', headers:{...(authenticated?{Authorization:`Bearer ${env.SCOUT_API_TOKEN}`} : {}),...(body?{'Content-Type':'application/json'}:{})},
  body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000),redirect:'error',
});
const get = async path => { const response=await request(path); assert.equal(response.status,200); return response.json(); };
const until = async (check,message) => {for(let i=0;i<160;i++){const result=await check();if(result)return result;await new Promise(r=>setTimeout(r,250));}throw new Error(message);};
const docker = args => new Promise((resolve,reject)=>{const child=spawn('docker',['compose',...args],{cwd:root,stdio:['ignore','ignore','inherit']});child.on('error',reject);child.on('close',code=>code===0?resolve():reject(new Error('Docker test operation failed.')));});
const submit = async body => {const response=await request('/v1/browser-jobs',body);assert.equal(response.status,202,await response.clone().text());return response.json();};
const job = async id => (await get('/v1/browser-jobs')).jobs.find(j=>j.job_id===id);
const settled = id => until(async()=>{const value=await job(id);return value&&!['queued','running'].includes(value.status)?value:null;},'Browser job did not settle.');
assert.equal((await get('/v1/model-providers')).test_mode,true,'GUI integration must use simulated providers.');
await until(async()=>(await get('/v1/browser-jobs')).workers.some(w=>w.available),'Worker did not register.');
const html=await request('/',undefined,false);
assert.equal(html.status,200);
assert.match(html.headers.get('content-security-policy'),/script-src 'self'/);
assert.ok(!(await html.text()).includes(env.SCOUT_API_TOKEN));
for(const path of ['/assets/app/main.js','/assets/ui/styles/tokens.css'])assert.equal((await request(path,undefined,false)).status,200);
for(const path of ['/v1/browser-jobs','/v1/operations','/v1/captures/'+randomUUID()+'/image','/v1/artifacts/'+randomUUID()+'/content'])assert.equal((await request(path,undefined,false)).status,401);
assert.equal((await request('/v1/browser-jobs',{job_id:randomUUID(),kind:'explore',target_url:'http://exploration-fixture:8082/'},false)).status,401);
for(const target_url of ['file:///tmp/test','http://example.com/','http://user:secret@exploration-fixture:8082/'])assert.equal((await request('/v1/browser-jobs',{job_id:randomUUID(),kind:'explore',target_url})).status,400);
assert.equal((await request('/v1/browser-jobs',{job_id:randomUUID(),kind:'explore',target_url:'http://exploration-fixture:8082/',execute_shell:'forbidden'})).status,400);
assert.equal((await request('/v1/browser-jobs',{job_id:randomUUID(),kind:'explore',target_url:'http://exploration-fixture:8082/',viewport_profile:'unsupported'})).status,400);

const original={job_id:randomUUID(),kind:'explore',target_url:'http://exploration-fixture:8082/broken-session',viewport_profile:'mobile'};
await submit(original);
const duplicate=await request('/v1/browser-jobs',original);
assert.equal(duplicate.status,200);assert.equal((await duplicate.json()).reused,true);
assert.equal((await request('/v1/browser-jobs',{...original,target_url:'http://exploration-fixture:8082/working'})).status,409);
const completed=await settled(original.job_id);
assert.equal(completed.status,'completed',completed.error);
const source=await get('/v1/runs/'+completed.run_id);
assert.equal(source.actions.length,2);
assert.equal(source.actions[1].assessment.verdict,'suspect');
assert.equal(source.run.config.viewport_profile,'mobile');
assert.deepEqual(source.run.config.viewport,{width:390,height:844});
assert.equal(source.run.config.browser_isolation,'sandbox','Worker runs must use the browser sandbox.');
for(const capture of source.captures){
  const image=await request('/v1/captures/'+capture.capture_id+'/image');assert.equal(image.status,200);
  assert.equal(image.headers.get('content-type'),'image/png');assert.equal(image.headers.get('cache-control'),'no-store');
  assert.equal(sha256(Buffer.from(await image.arrayBuffer())),capture.sha256);
}
for(const artifact of source.artifacts){const response=await request('/v1/artifacts/'+artifact.artifact_id+'/content');assert.equal(response.status,200);assert.equal(sha256(Buffer.from(await response.arrayBuffer())),artifact.sha256);}
for(const model of source.model_requests){const detail=await get('/v1/model-requests/'+model.request_id);assert.ok(detail.request.spec.prompt);assert.ok(detail.calls[0].output_text);}
const reproduction={job_id:randomUUID(),kind:'reproduce',source_action_id:source.actions[1].action_id};
await submit(reproduction);
const reproduced=await settled(reproduction.job_id);
assert.equal(reproduced.status,'completed',reproduced.error);
const replay=await get('/v1/runs/'+reproduced.run_id);
assert.equal(replay.reproductions[0].result.outcome,'reproduced');
assert.equal(replay.reproductions[0].result.confirmed_bug,false);
assert.equal(replay.model_usage.attempts,2);
assert.equal(replay.run.config.viewport_profile,'mobile');
assert.equal(replay.run.config.browser_isolation,'sandbox');
assert.equal((await request('/v1/browser-jobs',reproduction)).status,200);

const interaction={job_id:randomUUID(),kind:'explore',target_url:'http://exploration-fixture:8082/interactions',viewport_profile:'tablet'};
await submit(interaction);
const interacted=await settled(interaction.job_id);
assert.equal(interacted.status,'completed',interacted.error);
const interactionReport=await get('/v1/runs/'+interacted.run_id);
assert.deepEqual(interactionReport.actions.map(a=>a.spec.command.type),['navigate','fill','select','set_checked','set_checked','click']);
assert.equal(interactionReport.actions[1].spec.command.value,'notebook');
assert.equal(interactionReport.actions[2].spec.command.value,'books');
assert.equal(interactionReport.actions[3].spec.command.checked,true);
assert.equal(interactionReport.actions[4].spec.command.checked,true);
assert.ok(interactionReport.actions.every(a=>a.assessment.verdict==='no_issue_observed'));
assert.equal(interactionReport.run.config.viewport_profile,'tablet');

// Exercise the URL-only queue through the same safe form journey as the worker UI.
const journey={job_id:randomUUID(),kind:'explore',target_url:'http://exploration-fixture:8082/journeys/search',viewport_profile:'mobile'};
await submit(journey);
const journeyJob=await settled(journey.job_id);
assert.equal(journeyJob.status,'completed',journeyJob.error);
const journeyReport=await get('/v1/runs/'+journeyJob.run_id);
assert.deepEqual(journeyReport.actions.slice(0,5).map(a=>a.spec.command.type),['navigate','submit','fill','submit','click']);
assert.ok(journeyReport.actions.every(a=>a.outcome?.status==='settled'));
assert.equal(journeyReport.run.config.viewport_profile,'mobile');
const submitted=journeyReport.actions[3];
const frames=journeyReport.events.filter(e=>e.action_id===submitted.action_id&&e.event_type==='action.settling_frame');
assert.ok(frames.length>2);
const frame=frames[0].payload;
const frameResponse=await request('/v1/artifacts/'+frame.artifact.artifact_id+'/content');
assert.equal(frameResponse.status,200);assert.equal(frameResponse.headers.get('content-type'),'image/png');
assert.equal(sha256(Buffer.from(await frameResponse.arrayBuffer())),frame.sha256);
assert.equal((await request('/v1/artifacts/'+frame.artifact.artifact_id+'/content',undefined,false)).status,401);
for(const artifact of [submitted.outcome.completion_artifact,submitted.outcome.diagnostics_artifact]){
  const response=await request('/v1/artifacts/'+artifact.artifact_id+'/content');assert.equal(response.status,200);
  assert.equal(sha256(Buffer.from(await response.arrayBuffer())),artifact.sha256);
}

// Foreign metadata can reference the same blob; identity/ownership must still win.
const foreignRun=randomUUID(),foreignAction=randomUUID(),foreignCapture=randomUUID(),foreignArtifact=randomUUID();
await postgres(`INSERT INTO runtime_runs(run_id,workspace_id,user_id,target_url,lifecycle,config) VALUES(${sqlString(foreignRun)},${sqlString(randomUUID())},${sqlString(randomUUID())},'http://fixture.invalid/','completed','{}');
INSERT INTO runtime_actions(action_id,run_id,ordinal,prediction_id,spec,state) VALUES(${sqlString(foreignAction)},${sqlString(foreignRun)},1,${sqlString(randomUUID())},'{}','completed');
INSERT INTO runtime_captures(capture_id,run_id,action_id,phase,status,object_key,sha256,byte_length) SELECT ${sqlString(foreignCapture)},${sqlString(foreignRun)},${sqlString(foreignAction)},'before','available',object_key,sha256,byte_length FROM runtime_captures WHERE capture_id=${sqlString(source.captures[0].capture_id)};
INSERT INTO runtime_artifacts(artifact_id,run_id,kind,object_key,sha256,byte_length,status) SELECT ${sqlString(foreignArtifact)},${sqlString(foreignRun)},kind,object_key,sha256,byte_length,status FROM runtime_artifacts WHERE artifact_id=${sqlString(source.artifacts[0].artifact_id)};`);
try{
  assert.equal((await request('/v1/captures/'+foreignCapture+'/image')).status,404);
  assert.equal((await request('/v1/artifacts/'+foreignArtifact+'/content')).status,404);
}finally{
  await postgres(`DELETE FROM runtime_artifacts WHERE run_id=${sqlString(foreignRun)};DELETE FROM runtime_captures WHERE run_id=${sqlString(foreignRun)};DELETE FROM runtime_actions WHERE run_id=${sqlString(foreignRun)};DELETE FROM runtime_runs WHERE run_id=${sqlString(foreignRun)};`);
}

// Kill this test's worker while an assessment is in flight. Recovery must not replay.
const interrupted={job_id:randomUUID(),kind:'explore',target_url:'http://exploration-fixture:8082/working?case:delayed'};
await submit(interrupted);
const active=await until(async()=>{const value=await job(interrupted.job_id);if(!value?.run_id)return null;const report=await get('/v1/runs/'+value.run_id);return report.actions.some(a=>a.dispatched_at&&!a.finished_at)?value:null;},'No dispatched action observed for interruption test.');
await docker(['stop','-t','1','browser-worker']);
const stopped=await get('/v1/runs/'+active.run_id);
await docker(['start','browser-worker']);
const recovered=await settled(interrupted.job_id);
assert.equal(recovered.status,'interrupted');
assert.equal(recovered.run_id,active.run_id,'Recovery must retain the interrupted run instead of starting another session.');
assert.equal(recovered.resumes,0);
assert.deepEqual(recovered.previous_run_ids,[]);
const final=await get('/v1/runs/'+active.run_id);
assert.equal(final.actions.length,stopped.actions.length);
assert.equal(final.model_requests.length,stopped.model_requests.length);
assert.ok(final.actions.some(a=>a.assessment?.verdict==='inconclusive'));
assert.equal(final.run.lifecycle,'failed');
assert.equal((await request('/v1/browser-jobs',interrupted)).status,200);
const operations=await get('/v1/operations');assert.equal(operations.database,'reachable');assert.ok(operations.captures>=source.captures.length);assert.ok(Number(operations.settling_frames)>=frames.length);
await until(async()=>Number((await get('/v1/operations')).pending_runtime_events)===0,'Recovered events were not exported while the worker was idle.');
await mkdir(new URL('../artifacts/workspace/',import.meta.url),{recursive:true});
const result={status:'passed',verified_at:new Date().toISOString(),mode:'simulated_models_real_browser_worker',source_run_id:source.run.run_id,replay_run_id:replay.run.run_id,interrupted_run_id:active.run_id,interaction_run_id:interacted.run_id,journey_run_id:journeyJob.run_id,
  checks:['public_UI_shell_private_data','CSP_and_no_embedded_secret','URL_job_admission','idempotent_submission','invalid_scope_rejected','viewport_profile_admission','worker_execution','queued_native_interactions','queued_form_journey','completion_and_diagnostics_artifact_API','settling_frame_API_auth_and_hash','capture_and_artifact_hashes','model_request_response_inspection','GUI_reproduction_endpoint','source_viewport_reproduction','cross_workspace_image_isolation','process_interruption_without_replay','idle_recovery_event_export','operations_snapshot'],visual_browser_check:'unverified_tool_restricted'};
await writeFile(new URL('../artifacts/workspace/verification.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
