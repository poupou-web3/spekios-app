import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { spawn } from 'node:child_process';
import { clients, getObject, sha256, root, sqlString } from './local-clients.mjs';

const env=parseEnv(await readFile(new URL('../.env',import.meta.url),'utf8'));
const get=async path=>{const response=await fetch('http://127.0.0.1:18080'+path,{headers:{Authorization:`Bearer ${env.SCOUT_API_TOKEN}`},signal:AbortSignal.timeout(10000)});assert.equal(response.status,200);return response.json();};
const run=(command,target,limit=6)=>new Promise((resolve,reject)=>{
  const child=spawn('docker',['compose','run','--rm','--no-deps','-e','SCOUT_EXPLORER_PROVIDER=openrouter','-e','SCOUT_EXPLORER_MODEL=scout-interactions-fixture:free','-e',`SCOUT_EXPLORER_MAX_ACTIONS=${limit}`,'recorder',command,target],{cwd:root,stdio:['ignore','pipe','inherit']});
  let output='';child.stdout.on('data',chunk=>output+=chunk);child.on('error',reject);
  child.on('close',code=>{if(code!==0)return reject(new Error(`Interaction verification failed: ${output.slice(0,1200)}`));try{resolve(JSON.parse(output));}catch(error){reject(error);}});
});
assert.equal((await get('/v1/model-providers')).test_mode,true);
const {s3,clickhouse}=await clients();
try{
  const matrix=await run('explore-matrix','http://exploration-fixture:8082/interactions');
  const reports=[];
  for(const entry of matrix.runs){
    const report=await get('/v1/runs/'+entry.run_id);reports.push(report);
    assert.deepEqual(report.actions.map(a=>a.spec.command.type),['navigate','fill','select','set_checked','set_checked','click']);
    assert.ok(report.actions.every(a=>a.assessment.verdict==='no_issue_observed'));
    assert.equal(report.run.config.viewport_profile,entry.viewport_profile);
  }
  const replays=[];
  for(const [path,limit] of [['/interactions/broken',6],['/scrolling/manual/broken',3]]){
    const source=await run('explore','http://exploration-fixture:8082'+path,limit);
    const report=await get('/v1/runs/'+source.run_id);reports.push(report);
    const replay=await run('reproduce',report.actions.at(-1).action_id);
    const fresh=await get('/v1/runs/'+replay.run_id);reports.push(fresh);
    assert.equal(fresh.reproductions[0].result.outcome,'reproduced');
    assert.deepEqual(fresh.actions.map(a=>a.spec.command),report.actions.map(a=>a.spec.command));
    replays.push({source_run_id:source.run_id,replay_run_id:replay.run_id});
  }
  for(const report of reports){
    const manifest=JSON.parse((await getObject(s3,report.run.manifest_key)).toString());
    // The worker's pg Date serialization uses milliseconds; the API's JSON
    // retains PostgreSQL microseconds. Compare their common timestamp precision.
    const normalize=actions=>actions.map(action=>({...action,...Object.fromEntries(['created_at','dispatched_at','finished_at'].map(key=>[key,action[key]===null?null:new Date(action[key]).toISOString()]))}));
    assert.deepEqual(normalize(manifest.actions),normalize(report.actions));
    assert.equal(manifest.run.config.interaction_version,'browser-interactions-v2');
    assert.equal(manifest.run.config.screenshot_caret,'hide');
    assert.equal(report.model_usage.incomplete_usage_attempts,0);
    for(const capture of report.captures)assert.equal(sha256(await getObject(s3,capture.object_key)),capture.sha256);
    for(const artifact of report.artifacts)assert.equal(sha256(await getObject(s3,artifact.object_key)),artifact.sha256);
    const count=JSON.parse(await clickhouse(`SELECT count() AS n FROM scout.runtime_events_current WHERE run_id=${sqlString(report.run.run_id)} FORMAT JSONEachRow`));
    assert.equal(Number(count.n),report.events.length);
  }
  const result={status:'passed',verified_at:new Date().toISOString(),mode:'simulated_models_real_browser',interaction_version:'browser-interactions-v2',
    viewports:matrix.runs,replays,checks:['fill_select_checkbox_radio','responsive_viewports','offscreen_discovery_by_scroll','exact_parameter_replay','capture_and_artifact_hashes','immutable_manifests','model_usage','ClickHouse_events'],visual_browser_check:'unverified_tool_restricted'};
  await mkdir(new URL('../artifacts/browser-interactions/',import.meta.url),{recursive:true});
  await writeFile(new URL('../artifacts/browser-interactions/verification.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result,null,2));
}finally{s3.destroy();}
