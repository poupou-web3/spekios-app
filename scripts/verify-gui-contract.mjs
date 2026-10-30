import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { createHash } from 'node:crypto';

const env=parseEnv(await readFile(new URL('../.env',import.meta.url),'utf8'));
const origin='http://127.0.0.1:18080';
const get=async path=>{
  const r=await fetch(origin+path,{headers:{Authorization:`Bearer ${env.SCOUT_API_TOKEN}`},signal:AbortSignal.timeout(15000),redirect:'error'});
  assert.equal(r.status,200,path);return r.json();
};
const sha=value=>createHash('sha256').update(value).digest('hex');
// Served path below /assets/ → source file. The back office is a separate container and must not be served here.
for(const [file,source] of [['app/main.js','apps/web/src/main.js'],['app/views/run.js','apps/web/src/views/run.js'],['app/styles/workspace.css','apps/web/src/styles/workspace.css'],['app/report/export.js','apps/web/src/report/export.js'],['app/report/bundle.js','apps/web/src/report/bundle.js'],['ui/styles/tokens.css','packages/web-ui/src/styles/tokens.css'],['ui/theme.js','packages/web-ui/src/theme.js']]){
  const served=await fetch(origin+'/assets/'+file);assert.equal(served.status,200);
  assert.equal(served.headers.get('cache-control'),'no-store',file);
  assert.equal(served.headers.get('x-content-type-options'),'nosniff',file);
  assert.equal(served.headers.get('content-type'),file.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8',file);
  assert.equal(sha(await served.text()),sha(await readFile(new URL('../'+source,import.meta.url),'utf8')),'Current '+file+' must be served.');
}
assert.equal((await fetch(origin+'/assets/app/../../../apps/backoffice/src/main.js')).status,404,'The back office is not part of the workspace deployment.');
const {runs}=await get('/v1/runs');let calls=0,reviews=0;
assert.ok(runs.length>0,'Run the local fixture suite before this verification.');
for(const run of runs){
  const report=await get('/v1/runs/'+run.run_id),latest=new Map();
  for(const review of report.finding_reviews){const prior=latest.get(review.action_id);if(!prior||review.revision>prior.revision)latest.set(review.action_id,review);}
  const original=run.config.runtime_version==='explorer-v1'&&run.config.replay_of===null;
  const candidates=original?report.actions.filter(a=>a.assessment?.verdict==='suspect'):[];
  assert.deepEqual(run.summary,{
    actions:report.actions.length,candidates:candidates.length,
    pending_findings:candidates.filter(a=>!latest.has(a.action_id)||latest.get(a.action_id).disposition==='needs_review').length,
    confirmed_findings:candidates.filter(a=>latest.get(a.action_id)?.disposition==='confirmed').length,
    dismissed_findings:candidates.filter(a=>latest.get(a.action_id)?.disposition==='dismissed').length,
  });
  assert.ok(Array.isArray(report.model_calls),'Run snapshots must expose actual attempts to the back office.');
  assert.equal(report.model_calls.length,Number(report.model_usage.attempts));
  for(const call of report.model_calls){
    assert.ok(report.model_requests.some(r=>r.request_id===call.request_id));
    for(const key of ['input_tokens','output_tokens','usage_status','cost_usd'])assert.ok(key in call);
    assert.equal('usage_raw' in call,false,'The list projection must not include full provider payloads.');
  }
  for(const [key,field] of [['input_tokens','known_input_tokens'],['output_tokens','known_output_tokens']]){
    const known=report.model_calls.filter(c=>c[key]!=null),total=known.length?known.reduce((sum,c)=>sum+Number(c[key]),0):null;
    assert.equal(report.model_usage[field]==null?null:Number(report.model_usage[field]),total);
  }
  calls+=report.model_calls.length;reviews+=report.finding_reviews.length;
}
const providers=await get('/v1/model-providers'),operations=await get('/v1/operations');
const preferences=await get('/v1/exploration-settings'),queue=await get('/v1/browser-jobs'),capabilities=await get('/v1/capabilities');
assert.deepEqual(queue.settings,preferences.settings);assert.equal(queue.settings_revision,preferences.revision);
assert.equal(capabilities.exploration_settings.revision,preferences.revision);
assert.equal(capabilities.exploration_settings.credentials_editable,false);assert.equal(capabilities.exploration_settings.origins_editable,false);
const result={status:'passed',verified_at:new Date().toISOString(),runs_checked:runs.length,attempts_checked:calls,review_revisions_seen:reviews,
  mode:providers.test_mode?'protocol_fixture':'live',pending_runtime_events:operations.pending_runtime_events,
  checks:['current_ui_assets','run_summary_matches_latest_reviews','replays_do_not_duplicate_candidate_totals','actual_attempts_and_nullable_usage','attempt_lineage_and_bounded_projection','saved_defaults_consistent_with_queue_and_capabilities'],visual_browser_check:'separate'};
await mkdir(new URL('../artifacts/gui/',import.meta.url),{recursive:true});
await writeFile(new URL('../artifacts/gui/contract-verification.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
