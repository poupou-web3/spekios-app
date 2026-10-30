import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { spawn } from 'node:child_process';
import { getObject, sha256, clients, sqlString } from './local-clients.mjs';

const env = parseEnv(await readFile(new URL('../.env',import.meta.url),'utf8'));
const { s3, clickhouse } = await clients();
const request = async path => {
  const response = await fetch('http://127.0.0.1:18080'+path,{headers:{Authorization:`Bearer ${env.SCOUT_API_TOKEN}`},signal:AbortSignal.timeout(10000),redirect:'error'});
  assert.equal(response.status,200);
  return response.json();
};
assert.equal((await request('/v1/model-providers')).test_mode,true,'Never run simulated tests against paid providers.');
const output = await new Promise((resolve,reject) => {
  const child = spawn('docker',['compose','run','--rm','--no-deps','-e','SCOUT_EXPLORER_PROVIDER=openrouter','-e','SCOUT_EXPLORER_MODEL=scout-explorer-fixture:free','-e','SCOUT_EXPLORER_MAX_ACTIONS=8','recorder','explore','http://exploration-fixture:8082/branches'],{stdio:['ignore','pipe','inherit']});
  let text='';child.stdout.on('data',chunk=>text+=chunk);
  child.on('error',reject);child.on('close',code=>code===0?resolve(JSON.parse(text)):reject(new Error(`URL explorer exited ${code}: ${text.slice(0,1500)}`)));
});
assert.equal(output.lifecycle,'completed');
assert.equal(output.actions,5);
assert.equal(output.captures,10);
assert.equal(output.model_usage.attempts,10);
assert.equal(output.model_usage.known_input_tokens,30);
assert.equal(output.model_usage.known_output_tokens,20);
assert.equal(output.manifest_error,null);
assert.equal(output.export_error,null);
const report=await request('/v1/runs/'+output.run_id);
assert.equal(report.run.config.browser_isolation,'sandbox','CLI explorations must use the browser sandbox.');
const graph=await request('/v1/runs/'+output.run_id+'/graph');
assert.deepEqual(report.graph,graph);
assert.equal(graph.states.length,4);
assert.equal(graph.coverage_complete,false);
const manifest=JSON.parse((await getObject(s3,output.manifest_key)).toString());
assert.equal(manifest.model_calls.length,10);
assert.equal(manifest.model_payloads.length,20);
for(const capture of report.captures)assert.equal(sha256(await getObject(s3,capture.object_key)),capture.sha256);
// Background model exporter is asynchronous; wait only for this run's requests.
let exported=false;
for(let attempt=0;attempt<120;attempt++){
  const calls=await Promise.all(report.model_requests.map(r=>request('/v1/model-requests/'+r.request_id)));
  if(calls.every(r=>r.payloads.length===2&&r.payloads.every(p=>p.uploaded_at)&&r.events.every(e=>e.exported_at))){
    for(const r of calls)for(const payload of r.payloads)assert.equal(sha256(await getObject(s3,payload.object_key)),payload.sha256);
    exported=true;break;
  }
  await new Promise(resolve=>setTimeout(resolve,250));
}
assert.ok(exported,'Model evidence and events must export durably.');
const counts=JSON.parse(await clickhouse(`SELECT count() AS n FROM scout.runtime_events_current WHERE run_id=${sqlString(output.run_id)} FORMAT JSONEachRow`));
assert.equal(Number(counts.n),report.events.length);
await mkdir(new URL('../artifacts/explorer/',import.meta.url),{recursive:true});
await writeFile(new URL('../artifacts/explorer/verification.json',import.meta.url),JSON.stringify({status:'passed',verified_at:new Date().toISOString(),mode:'simulated_model_real_browser',...output,checks:['URL_only_entrypoint','Rust_graph_API','branch_deduplication','all_capture_hashes','all_model_payload_hashes','token_totals','ClickHouse_export','manifest_lineage']},null,2)+'\n');
console.log(JSON.stringify({status:'passed',run_id:output.run_id,actions:output.actions,captures:output.captures,states:graph.states.length,model_requests:10,model_mode:'protocol_fixture',coverage_complete:false},null,2));
s3.destroy();
