import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { spawn } from 'node:child_process';
import { clients, getObject, sha256, root, sqlString } from './local-clients.mjs';

const env=parseEnv(await readFile(new URL('../.env',import.meta.url),'utf8'));
const get=async path=>{const r=await fetch('http://127.0.0.1:18080'+path,{headers:{Authorization:`Bearer ${env.SCOUT_API_TOKEN}`},signal:AbortSignal.timeout(10000)});assert.equal(r.status,200);return r.json();};
const run=(command,url,limit=5)=>new Promise((resolve,reject)=>{
  const child=spawn('docker',['compose','run','--rm','--no-deps','-e','SCOUT_EXPLORER_PROVIDER=openrouter','-e','SCOUT_EXPLORER_MODEL=scout-explorer-fixture:free','-e',`SCOUT_EXPLORER_MAX_ACTIONS=${limit}`,'recorder',command,url],{cwd:root,stdio:['ignore','pipe','inherit']});
  let output='';child.stdout.on('data',chunk=>output+=chunk);child.on('error',reject);
  child.on('close',code=>{if(code!==0)return reject(new Error(`Planner verification command failed: ${output.slice(0,1200)}`));try{resolve(JSON.parse(output));}catch(e){reject(e);}});
});
assert.equal((await get('/v1/model-providers')).test_mode,true,'Planner checks must use simulated models.');
const {s3,clickhouse}=await clients();
try{
  const tree=await run('explore','http://exploration-fixture:8082/tree');
  const report=await get('/v1/runs/'+tree.run_id);
  assert.deepEqual(report.actions.map(a=>a.spec.command.type==='navigate'?'navigate':a.spec.command.control.name),['navigate','Catalog','navigate','Help','Save draft']);
  assert.equal(report.actions[2].spec.exploration.purpose,'return');
  assert.equal(report.actions[4].assessment.verdict,'suspect');
  for(const selection of report.graph.selections){
    assert.ok(report.actions.some(a=>a.action_id===selection.action_id));
    assert.ok(report.captures.some(c=>c.capture_id===selection.context_capture_id));
    assert.ok(selection.ranked_paths.length>0);
    assert.equal(selection.probability_calibrated,false);
  }
  const replay=await run('reproduce',report.actions[4].action_id);
  assert.equal(replay.reproductions[0].result.outcome,'reproduced');
  const menu=await run('explore','http://exploration-fixture:8082/changing-controls',3);
  const menuReport=await get('/v1/runs/'+menu.run_id);
  assert.equal(menuReport.graph.selections.at(-1).selected.name,'Menu item');
  const matrix=await run('explore-matrix','http://exploration-fixture:8082/responsive',2);
  assert.deepEqual(matrix.runs.map(r=>r.viewport_profile),['desktop','tablet','mobile']);
  const reports=[report,menuReport,await get('/v1/runs/'+replay.run_id),...await Promise.all(matrix.runs.map(r=>get('/v1/runs/'+r.run_id)))];
  for(const item of reports){
    const manifest=JSON.parse((await getObject(s3,item.run.manifest_key)).toString());
    assert.equal(manifest.graph.selections.length,item.graph.selections.length);
    assert.equal(manifest.run.config.viewport_profile,item.run.config.viewport_profile);
    for(const capture of item.captures)assert.equal(sha256(await getObject(s3,capture.object_key)),capture.sha256);
    for(const artifact of item.artifacts)assert.equal(sha256(await getObject(s3,artifact.object_key)),artifact.sha256);
    const count=JSON.parse(await clickhouse(`SELECT count() AS n FROM scout.runtime_events_current WHERE run_id=${sqlString(item.run.run_id)} FORMAT JSONEachRow`));
    assert.equal(Number(count.n),item.events.length);
  }
  const result={status:'passed',verified_at:new Date().toISOString(),mode:'simulated_models_real_browser',planner:report.run.config.planner_version,
    tree_run_id:tree.run_id,replay_run_id:replay.run_id,changed_controls_run_id:menu.run_id,viewports:matrix.runs,
    checks:['dead_end_return','ranked_branch_lineage','change_aware_priority','return_path_reproduction','three_viewport_CLI_matrix','capture_and_artifact_hashes','immutable_manifest','ClickHouse_events'],
    probability_calibrated:false,visual_GUI_check:'unverified_tool_restricted'};
  await mkdir(new URL('../artifacts/exploration-planner/',import.meta.url),{recursive:true});
  await writeFile(new URL('../artifacts/exploration-planner/verification.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result,null,2));
}finally{s3.destroy();}
