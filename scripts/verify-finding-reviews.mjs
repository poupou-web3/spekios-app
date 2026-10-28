import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { spawn } from 'node:child_process';
import { root, postgres, sqlString, clients, getObject, sha256 } from './local-clients.mjs';

const env=parseEnv(await readFile(new URL('../.env',import.meta.url),'utf8'));
const artifact=new URL('../artifacts/finding-reviews/verification.json',import.meta.url);
const request=(path,body,authenticated=true)=>fetch('http://127.0.0.1:18080'+path,{
  method:body?'POST':'GET',headers:{...(authenticated?{Authorization:`Bearer ${env.SCOUT_API_TOKEN}`} : {}),'Content-Type':'application/json'},
  body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(55000),
});
const get=async path=>{const r=await request(path);assert.equal(r.status,200,path);return r.json();};
async function until(check,label){
  const end=Date.now()+60000;
  while(Date.now()<end){const result=await check();if(result)return result;await new Promise(r=>setTimeout(r,200));}
  throw new Error('Timed out: '+label);
}
const report=id=>get('/v1/runs/'+id);
const latest=(r,id)=>r.finding_reviews.filter(f=>f.action_id===id).sort((a,b)=>b.revision-a.revision)[0];
const submit=async spec=>{
  const jobId=randomUUID(),r=await request('/v1/browser-jobs',{job_id:jobId,...spec});assert.equal(r.status,202,await r.clone().text());
  const job=await until(async()=>{const j=(await get('/v1/browser-jobs')).jobs.find(j=>j.job_id===jobId);return j&&!['queued','running'].includes(j.status)&&j;},'browser job');
  assert.equal(job.status,'completed',job.error);return report(job.run_id);
};
const draft=(revision,disposition='needs_review')=>({review_id:randomUUID(),expected_revision:revision,disposition,
  rationale:disposition==='confirmed'?'The independent replay shows the same failure.':'A human review decision for this controlled fixture.',
  expectation_basis:disposition==='confirmed'?'The visible Save control promises to save the displayed draft.':'',severity:disposition==='confirmed'?'medium':null});
const review=async(id,body,status=201)=>{
  const response=await request(`/v1/actions/${id}/reviews`,body),value=await response.json();
  assert.equal(response.status,status,JSON.stringify(value));return value;
};
const docker=args=>new Promise((resolve,reject)=>{
  const p=spawn('docker',['compose',...args],{cwd:root,stdio:['ignore','ignore','inherit']});
  p.on('error',reject);p.on('close',code=>code===0?resolve():reject(new Error('Local review test operation failed.')));
});
const providers=await get('/v1/model-providers');
const {s3,clickhouse}=await clients();

if(process.argv.includes('--integrity-regression')){
  try{
    const saved=JSON.parse(await readFile(artifact,'utf8'));
    const source=await report(saved.source_run_id),replay=await report(saved.replay_run_id),id=saved.source_action_id;
    const revision=latest(source,id).revision;
    const cases=[
      {action:source.actions[0],outcome:null},
      {action:replay.actions[0],outcome:null},
      {action:replay.actions.at(-1),outcome:{...replay.actions.at(-1).outcome,diagnostics_artifact:null}},
    ];
    for(const fault of cases){
      await postgres(`UPDATE runtime_actions SET outcome=${sqlString(JSON.stringify(fault.outcome))}::jsonb WHERE action_id=${sqlString(fault.action.action_id)};`);
      try{
        const response=await request(`/v1/actions/${id}/reviews`,draft(revision,'confirmed'));
        assert.equal(response.status,409,await response.clone().text());
      }finally{
        await postgres(`UPDATE runtime_actions SET outcome=${sqlString(JSON.stringify(fault.action.outcome))}::jsonb WHERE action_id=${sqlString(fault.action.action_id)};`);
      }
    }
    assert.equal(latest(await report(saved.source_run_id),id).revision,revision);
    const final=await review(id,draft(revision,'confirmed'));
    await until(async()=>Number((await get('/v1/operations')).pending_runtime_events)===0,'completion-integrity review export');
    const after=await report(saved.source_run_id);
    assert.deepEqual(after.actions,source.actions);
    assert.deepEqual((await report(saved.replay_run_id)).actions,replay.actions);
    assert.equal(after.model_requests.length,source.model_requests.length);
    saved.integrity_regression={verified_at:new Date().toISOString(),review_id:final.review.review_id,
      checks:['source_prefix_completion_required','replay_prefix_completion_required','replay_target_completion_artifacts_required','valid_evidence_still_confirmable']};
    await writeFile(artifact,JSON.stringify(saved,null,2)+'\n');
    console.log(JSON.stringify({status:'passed',integrity_regression:saved.integrity_regression},null,2));
  }finally{s3.destroy();}
  process.exit(0);
}

if(process.argv.includes('--normal-mode')){
  try{
    assert.equal(providers.test_mode,false);
    const saved=JSON.parse(await readFile(artifact,'utf8'));
    const before=await report(saved.source_run_id),id=saved.source_action_id;
    const first=await review(id,draft(latest(before,id).revision));
    const confirmed=await review(id,draft(first.review.revision,'confirmed'));
    await until(async()=>Number((await get('/v1/operations')).pending_runtime_events)===0,'normal-mode review export');
    const after=await report(saved.source_run_id);
    assert.equal(after.model_requests.length,before.model_requests.length);
    assert.equal(after.finding_reviews.at(-1).disposition,'confirmed');
    saved.normal_mode={verified_at:new Date().toISOString(),configured_providers:providers.providers.filter(p=>p.configured).map(p=>p.provider),review_id:confirmed.review.review_id,
      checks:['human_review_without_new_inference','idle_export_in_normal_mode']};
    await writeFile(artifact,JSON.stringify(saved,null,2)+'\n');
    console.log(JSON.stringify({status:'passed',normal_mode:saved.normal_mode},null,2));
  }finally{s3.destroy();}
  process.exit(0);
}

const checks=[];
try{
  assert.equal(providers.test_mode,true,'The browser fixtures must use simulated models.');
  assert.equal((await request(`/v1/actions/${randomUUID()}/reviews`,draft(0),false)).status,401);
  assert.equal((await request(`/v1/actions/${randomUUID()}/reviews`,draft(0))).status,404);
  assert.equal((await request('/v1/actions/not-a-uuid/reviews',draft(0))).status,400);
  const source=await submit({kind:'explore',target_url:'http://exploration-fixture:8082/broken-session'});
  const suspect=source.actions.find(a=>a.assessment?.verdict==='suspect');assert.ok(suspect);
  const sourceId=source.run.run_id,id=suspect.action_id;
  const originalManifest=await getObject(s3,source.run.manifest_key);
  const originalActions=source.actions,originalConfig=source.run.config;
  assert.deepEqual(source.finding_reviews,[]);
  for(const body of [
    {...draft(0),unexpected:true},{...draft(0),disposition:'invented'},
    {...draft(0),rationale:'  '},{...draft(0),rationale:'x'.repeat(2001)},
    {...draft(0),expected_revision:-1},{...draft(0,'confirmed'),expectation_basis:''},
    {...draft(0,'confirmed'),severity:null},
  ])assert.equal((await request(`/v1/actions/${id}/reviews`,body)).status,400);
  const blocked=await review(id,draft(0,'confirmed'),409);assert.equal(blocked.error,'reproduction_required');
  checks.push('authenticated_strict_review_admission','confirmation_requires_independent_reproduction');

  const foreignRun=randomUUID(),foreignAction=randomUUID();
  await postgres(`INSERT INTO runtime_runs(run_id,workspace_id,user_id,target_url,lifecycle,config) VALUES(${sqlString(foreignRun)},${sqlString(randomUUID())},${sqlString(randomUUID())},'http://fixture.invalid/','completed','{"runtime_version":"explorer-v1"}');
    INSERT INTO runtime_actions(action_id,run_id,ordinal,prediction_id,spec,state) VALUES(${sqlString(foreignAction)},${sqlString(foreignRun)},1,${sqlString(randomUUID())},'{}','completed');`);
  try{assert.equal((await request(`/v1/actions/${foreignAction}/reviews`,draft(0))).status,404);}
  finally{await postgres(`DELETE FROM runtime_actions WHERE action_id=${sqlString(foreignAction)};DELETE FROM runtime_runs WHERE run_id=${sqlString(foreignRun)};`);}
  assert.equal((await request(`/v1/actions/${source.actions[0].action_id}/reviews`,draft(0))).status,409);
  checks.push('workspace_and_source_action_isolation');

  const dismissed=await review(id,draft(0,'dismissed'));assert.equal(dismissed.review.revision,1);
  await until(async()=>Number((await get('/v1/operations')).pending_runtime_events)===0,'idle human-review event export');
  assert.equal((await report(sourceId)).model_requests.length,source.model_requests.length);
  const reopened=await review(id,draft(1));assert.equal(reopened.review.revision,2);
  const replay=await submit({kind:'reproduce',source_action_id:id});
  assert.equal(replay.reproductions[0].result.outcome,'reproduced');
  assert.equal(replay.reproductions[0].result.matching_after_state,true);
  assert.equal((await request(`/v1/actions/${replay.actions.at(-1).action_id}/reviews`,draft(0))).status,409);
  checks.push('dismiss_and_reopen_without_inference','replay_cannot_be_reviewed_as_a_new_source');

  const candidates=[draft(2,'dismissed'),draft(2)];
  const raced=await Promise.all(candidates.map(body=>request(`/v1/actions/${id}/reviews`,body)));
  assert.deepEqual(raced.map(r=>r.status).sort(),[201,409]);
  const bodies=await Promise.all(raced.map(r=>r.json()));
  assert.equal(bodies.find(b=>b.error)?.error,'revision_conflict');
  let revision=bodies.find(b=>b.review).review.revision;
  assert.equal(revision,3);
  const confirmBody=draft(revision,'confirmed'),confirmed=await review(id,confirmBody);
  revision=confirmed.review.revision;
  assert.equal(confirmed.review.disposition,'confirmed');
  assert.ok(JSON.stringify(confirmed.review.evidence_snapshot).includes(suspect.before_capture_id));
  assert.ok(JSON.stringify(confirmed.review.evidence_snapshot).includes(replay.run.run_id));
  assert.ok(JSON.stringify(confirmed.review.evidence_snapshot).includes('excluded_fixture'));
  const confirmationEvent=(await report(sourceId)).events.find(e=>e.event_type==='finding.reviewed'&&e.payload.review_id===confirmed.review.review_id);
  assert.ok(confirmationEvent);
  assert.ok(JSON.stringify(confirmationEvent.payload).includes('excluded_fixture'));
  const afterReopen=await review(id,draft(revision));revision=afterReopen.review.revision;
  const repeated=await review(id,confirmBody,200);
  assert.equal(repeated.reused,true);assert.equal(repeated.review.revision,confirmed.review.revision);
  assert.equal((await review(id,{...confirmBody,rationale:'Different text for the same logical review UUID.'},409)).error,'review_id_conflict');
  assert.equal((await review(id,draft(0),409)).error,'revision_conflict');
  checks.push('concurrent_revision_fencing','idempotent_review_after_later_revisions','evidence_and_fixture_exclusion_snapshot');

  const capture=replay.captures.find(c=>c.capture_id===replay.actions.at(-1).after_capture_id);
  for(const update of ["status='failed'","sha256='"+'0'.repeat(64)+"'"]){
    await postgres(`UPDATE runtime_captures SET ${update} WHERE capture_id=${sqlString(capture.capture_id)};`);
    try{const response=await request(`/v1/actions/${id}/reviews`,draft(revision,'confirmed'));assert.ok([409,502].includes(response.status));const error=await response.json();assert.ok(['incomplete_evidence','evidence_checksum_mismatch','evidence_invalid_metadata'].includes(error.error),JSON.stringify(error));}
    finally{await postgres(`UPDATE runtime_captures SET status='available',sha256=${sqlString(capture.sha256)} WHERE capture_id=${sqlString(capture.capture_id)};`);}
  }
  assert.equal(latest(await report(sourceId),id).revision,revision);
  const final=await review(id,draft(revision,'confirmed'));revision=final.review.revision;
  await assert.rejects(postgres(`UPDATE finding_reviews SET rationale='overwrite' WHERE review_id=${sqlString(final.review.review_id)};`));
  await assert.rejects(postgres(`DELETE FROM finding_reviews WHERE review_id=${sqlString(final.review.review_id)};`));
  checks.push('missing_or_tampered_replay_evidence_rejected','append_only_review_history');

  // Review writes remain authoritative while the analytics database is offline.
  await docker(['stop','clickhouse']);
  let offlineReview;
  try{
    offlineReview=await review(id,draft(revision));revision=offlineReview.review.revision;
    assert.equal(latest(await report(sourceId),id).review_id,offlineReview.review.review_id);
  }finally{await docker(['start','clickhouse']);}
  const finalConfirmed=await review(id,draft(revision,'confirmed'));
  await until(async()=>Number((await get('/v1/operations')).pending_runtime_events)===0,'review export after ClickHouse recovery');
  const after=await report(sourceId),afterReplay=await report(replay.run.run_id);
  assert.deepEqual(after.actions,originalActions);
  assert.deepEqual(after.run.config,originalConfig);
  assert.equal(after.run.manifest_key,source.run.manifest_key);
  assert.equal(sha256(await getObject(s3,after.run.manifest_key)),sha256(originalManifest));
  assert.deepEqual(afterReplay.reproductions,replay.reproductions);
  assert.equal(afterReplay.reproductions[0].result.confirmed_bug,false);
  assert.deepEqual(afterReplay.finding_reviews,after.finding_reviews);
  assert.deepEqual(after.finding_reviews.map(f=>f.revision),Array.from({length:after.finding_reviews.length},(_,i)=>i+1));
  const eventCount=Number((await clickhouse(`SELECT count(DISTINCT event_id) FROM scout.runtime_events WHERE run_id=${sqlString(sourceId)} AND event_type='finding.reviewed' FORMAT TabSeparated`)).trim());
  assert.equal(eventCount,after.finding_reviews.length);
  assert.equal(after.model_requests.length,source.model_requests.length);
  checks.push('durable_review_during_clickhouse_outage','idle_outbox_recovery','original_evidence_and_model_verdict_preserved','source_and_replay_review_lineage');
  const result={status:'passed',verified_at:new Date().toISOString(),mode:'human_review_simulated_models_real_browser_storage',source_run_id:sourceId,source_action_id:id,replay_run_id:replay.run.run_id,
    confirmed_review_id:finalConfirmed.review.review_id,revision:finalConfirmed.review.revision,checks,visual_check:'unverified'};
  await mkdir(new URL('../artifacts/finding-reviews/',import.meta.url),{recursive:true});
  await writeFile(artifact,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
}finally{s3.destroy();}
