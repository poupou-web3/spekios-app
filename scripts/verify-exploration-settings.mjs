import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import {spawn} from 'node:child_process';
import {postgres,root,sqlString} from './local-clients.mjs';

const env=parseEnv(await readFile(new URL('../.env',import.meta.url),'utf8'));
const request=(path,body)=>fetch('http://127.0.0.1:18080'+path,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${env.SCOUT_API_TOKEN}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(20000)});
const get=async path=>{const r=await request(path);assert.equal(r.status,200,path);return r.json();};
const values=s=>({provider:s.provider,model:s.model,max_actions:s.maxActions,viewport_profile:s.viewportProfile,free_only:s.freeOnly,auto_reproduce:s.autoReproduce,max_auto_reproductions:s.maxAutoReproductions,max_auto_replay_actions:s.maxAutoReplayActions,app_memory:s.appMemory!==false});
const save=async(body,status=201)=>{const r=await request('/v1/exploration-settings',body),result=await r.json();assert.equal(r.status,status,JSON.stringify(result));return result;};
const counts=async()=>JSON.parse(await postgres("SELECT json_build_object('requests',(SELECT count(*) FROM model_requests),'calls',(SELECT count(*) FROM model_calls),'actions',(SELECT count(*) FROM runtime_actions));"));
const snapshot=async()=>JSON.parse(await postgres("SELECT json_build_object('jobs',(SELECT coalesce(json_object_agg(job_id,settings),'{}'::json) FROM browser_jobs),'runs',(SELECT coalesce(json_object_agg(run_id,config),'{}'::json) FROM runtime_runs));"));
const docker=args=>new Promise((resolve,reject)=>{const p=spawn('docker',['compose',...args],{cwd:root,stdio:['ignore','ignore','inherit']});p.on('error',reject);p.on('close',code=>code===0?resolve():reject(new Error('Local settings test operation failed.')));});
const original=await get('/v1/exploration-settings'),originalValues=values(original.settings),before=await counts(),history=await snapshot(),jobs=[];
assert.ok(originalValues.model,'A nonempty original model is needed to restore saved preferences.');
assert.equal((await get('/v1/model-providers')).test_mode,true,'Use the isolated fixture overlay with the browser worker stopped.');
assert.equal(Number(await postgres("SELECT count(*) FROM browser_jobs WHERE status IN ('queued','running');")),0);
const checks=[];let receipt,second,restored;
try{
  const spec={request_id:randomUUID(),expected_revision:original.revision,...originalValues,provider:'openrouter',model:'openrouter/free',free_only:true,max_actions:7,viewport_profile:'tablet',auto_reproduce:false,max_auto_reproductions:3,max_auto_replay_actions:18};
  for(const patch of [{request_id:'00000000-0000-0000-0000-000000000000'},{expected_revision:-1},{provider:'unknown'},{model:'bad\nmodel'},{model:'<script>'},{model:'x'.repeat(201)},{max_actions:51},{max_auto_reproductions:4},{max_auto_replay_actions:101},{app_memory:'yes'},{free_only:'true'},{model:'vendor/paid'},{viewport_profile:'watch'},{api_key:'forbidden'},{allowedOrigins:['https://foreign.test']}])await save({...spec,...patch},400);
  checks.push('strict_nonsecret_schema_and_bounds');
  receipt=await save(spec);assert.equal(receipt.revision,original.revision+1);assert.equal(receipt.settings.settingsRevision,receipt.revision);
  const retry=await save(spec,200);assert.equal(retry.reused,true);assert.deepEqual(retry.settings,receipt.settings);
  assert.equal((await save({...spec,max_actions:8},409)).error,'settings_request_id_conflict');
  assert.equal((await save({...spec,request_id:randomUUID()},409)).error,'revision_conflict');
  const queue=await get('/v1/browser-jobs');assert.deepEqual(queue.settings,receipt.settings);assert.equal(queue.settings_revision,receipt.revision);
  const caps=await get('/v1/capabilities');assert.equal(caps.exploration_settings.revision,receipt.revision);assert.equal(caps.automatic_reproduction.max_cases,3);assert.equal(caps.automatic_reproduction.max_replay_actions,18);
  assert.deepEqual(receipt.settings.allowedOrigins,original.settings.allowedOrigins);
  assert.deepEqual(await counts(),before);assert.deepEqual(await snapshot(),history);checks.push('durable_scoped_defaults_without_inference_or_rewriting_history','optimistic_revision_and_uuid_idempotency','effective_queue_and_capabilities');
  const jobSpec={job_id:randomUUID(),kind:'explore',target_url:'http://exploration-fixture:8082/',auth_mode:'public'};jobs.push(jobSpec.job_id);
  let r=await request('/v1/browser-jobs',jobSpec);assert.equal(r.status,202,await r.clone().text());const job=(await r.json()).job;
  assert.equal(job.settings.settingsRevision,receipt.revision);assert.equal(job.settings.maxActions,7);assert.equal(job.settings.viewportProfile,'tablet');
  // Simulated-model jobs never depend on earlier test runs unless they ask for memory.
  assert.equal(receipt.settings.appMemory,spec.app_memory);assert.equal(job.settings.appMemory,false);assert.equal(job.request.app_memory,undefined);
  const remembering={...jobSpec,job_id:randomUUID(),app_memory:true};jobs.push(remembering.job_id);
  r=await request('/v1/browser-jobs',remembering);assert.equal(r.status,202,await r.clone().text());const rememberingJob=(await r.json()).job;
  assert.equal(rememberingJob.settings.appMemory,true);assert.equal(rememberingJob.request.app_memory,true);
  r=await request('/v1/browser-jobs',{job_id:randomUUID(),kind:'reproduce',source_action_id:randomUUID(),app_memory:false});assert.equal(r.status,400,'Replays never accept a memory choice.');
  const memory=await get('/v1/app-memory');assert.ok(Array.isArray(memory.scopes));
  second=await save({...spec,request_id:randomUUID(),expected_revision:receipt.revision,max_actions:4,viewport_profile:'mobile'});
  const old=await save(spec,200);assert.equal(old.revision,receipt.revision);assert.deepEqual(old.settings,receipt.settings);assert.equal((await get('/v1/exploration-settings')).revision,second.revision);
  r=await request('/v1/browser-jobs',jobSpec);assert.equal(r.status,200);const existing=await r.json();assert.equal(existing.reused,true);assert.deepEqual(existing.job.settings,job.settings);
  const newSpec={...jobSpec,job_id:randomUUID()};jobs.push(newSpec.job_id);r=await request('/v1/browser-jobs',newSpec);assert.equal(r.status,202,await r.clone().text());const newJob=(await r.json()).job;assert.equal(newJob.settings.settingsRevision,second.revision);assert.equal(newJob.settings.maxActions,4);assert.equal(newJob.settings.viewportProfile,'mobile');
  checks.push('admitted_jobs_freeze_their_revision','job_retries_keep_original_defaults','historical_settings_receipt_is_not_current_state','simulated_jobs_use_memory_only_when_requested');
  await docker(['restart','api']);
  let ready=false;for(let n=0;n<60;n++){try{const s=await get('/v1/exploration-settings');assert.deepEqual(s.settings,second.settings);ready=true;break;}catch{await new Promise(resolve=>setTimeout(resolve,200));}}
  assert.ok(ready,'Settings must survive an API restart.');checks.push('api_restart_preserves_saved_revision');
  const appendOnly=await postgres("SELECT count(*) FROM pg_trigger WHERE tgname='exploration_settings_append_only' AND NOT tgisinternal;");assert.equal(Number(appendOnly),1);
  await assert.rejects(postgres(`UPDATE exploration_settings_versions SET settings=settings WHERE request_id=${sqlString(spec.request_id)};`),/append-only/);
  checks.push('settings_history_rejects_mutation');
}finally{
  for(const id of jobs){const r=await request(`/v1/browser-jobs/${id}/cancel`,{cancellation_id:randomUUID()});assert.ok([200,404].includes(r.status),await r.text());}
  const current=await get('/v1/exploration-settings');restored=await save({request_id:randomUUID(),expected_revision:current.revision,...originalValues});
  assert.deepEqual(values(restored.settings),originalValues);assert.deepEqual(await counts(),before);
  const after=await snapshot();for(const [id,settings] of Object.entries(history.jobs))assert.deepEqual(after.jobs[id],settings);assert.deepEqual(after.runs,history.runs);
}
checks.push('original_preferences_restored_by_append_only_revision','zero_model_calls_and_unchanged_recorded_evidence');
const result={status:'passed',verified_at:new Date().toISOString(),checks,original_revision:original.revision,saved_revision:receipt.revision,next_revision:second.revision,restored_revision:restored.revision,cancelled_fixture_jobs:jobs,model_calls_added:0};
await mkdir(new URL('../artifacts/exploration-settings/',import.meta.url),{recursive:true});await writeFile(new URL('../artifacts/exploration-settings/verification.json',import.meta.url),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
