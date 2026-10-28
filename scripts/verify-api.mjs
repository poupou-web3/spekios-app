import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { parseEnv } from 'node:util';
import { request as httpRequest } from 'node:http';
import { postgres, sqlString } from './local-clients.mjs';

const env = parseEnv(await readFile(new URL('../.env', import.meta.url), 'utf8'));
assert.ok(env.SCOUT_API_TOKEN);
const request = (path, authenticated = true, extraHeaders = {}) => fetch('http://127.0.0.1:18080' + path, {
  headers: { ...(authenticated ? { Authorization: `Bearer ${env.SCOUT_API_TOKEN}` } : {}), ...extraHeaders },
  signal: AbortSignal.timeout(10000), redirect: 'error',
});
assert.equal((await request('/healthz', false)).status, 200);
const modeResponse=await request('/v1/auth-mode',false);
assert.equal(modeResponse.status,200);assert.equal(modeResponse.headers.get('cache-control'),'no-store');
const accessMode=(await modeResponse.json()).mode;
assert.ok(['local_development','bearer_token'].includes(accessMode));
const localDevelopment=accessMode==='local_development';
assert.equal((await request('/v1/runs', false)).status, localDevelopment?200:401);
assert.equal((await request('/v1/runs', false,{Authorization:'Bearer invalid'})).status,401);
for(const headers of [{Origin:'http://untrusted.test'},{'Sec-Fetch-Site':'cross-site'},{Origin:'null'}]){
  assert.equal((await request('/v1/runs',false,headers)).status,401,'Cross-origin or nonlocal requests cannot bypass access.');
  assert.equal((await (await request('/v1/auth-mode',false,headers)).json()).mode,'bearer_token');
}
// Node fetch may rewrite Host; use the HTTP transport to test rebinding fences.
const foreignHost=path=>new Promise((resolve,reject)=>{
  const request=httpRequest('http://127.0.0.1:18080'+path,{headers:{Host:'untrusted.test'}},response=>{
    let body='';response.on('data',chunk=>{body+=chunk;});response.on('end',()=>resolve({status:response.statusCode,body}));response.on('error',reject);
  });request.on('error',reject);request.setTimeout(10000,()=>request.destroy(new Error('Host check timed out.')));request.end();
});
assert.equal((await foreignHost('/v1/runs')).status,401);
assert.equal(JSON.parse((await foreignHost('/v1/auth-mode')).body).mode,'bearer_token');
const deniedWrite=await fetch('http://127.0.0.1:18080/v1/browser-jobs',{method:'POST',headers:{Origin:'http://untrusted.test','Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(10000)});
assert.equal(deniedWrite.status,401);
assert.equal((await request('/readyz')).status, 200);
const capabilities = await (await request('/v1/capabilities')).json();
assert.equal(capabilities.model_gateway, true);
assert.equal(capabilities.unbounded_exploration, false);
assert.equal(capabilities.workspace_ui, true);
assert.equal(capabilities.browser_job_submission, true);
assert.deepEqual(capabilities.bounded_url_exploration.entrypoints, ['recorder_cli','browser_jobs_api','workspace_ui']);
assert.deepEqual(capabilities.suspect_reproduction.entrypoints, ['recorder_cli','browser_jobs_api','workspace_ui']);
assert.equal(capabilities.suspect_reproduction.automatic_confirmation, false);
const providers=await (await request('/v1/model-providers')).json();
assert.equal(providers.gateway_ready,true);
assert.equal(capabilities.model_inference,providers.providers.some(p=>p.configured));
assert.ok(providers.providers.every(p=>p.subscription_auth===false));
const usage=await (await request('/v1/usage')).json();
assert.equal(usage.execution_mode,providers.test_mode?'protocol_fixture':'live');
const list = await (await request('/v1/runs')).json();
assert.ok(list.runs.length > 0, 'Run the recorder demo first.');
const runId = list.runs[0].run_id;
const reportResponse = await request('/v1/runs/' + runId);
assert.equal(reportResponse.status, 200);
assert.equal(reportResponse.headers.get('cache-control'), 'no-store');
const report = await reportResponse.json();
assert.equal(report.run.run_id, runId);
assert.ok(report.actions.length > 0);
assert.ok(report.captures.length > 0);
const capture = await (await request('/v1/captures/' + report.captures[0].capture_id)).json();
assert.equal(capture.run_id, runId);
assert.equal(capture.action_id, report.captures[0].action_id);
assert.equal((await request('/v1/runs/not-a-uuid')).status, 400);
assert.equal((await request('/v1/runs/' + randomUUID())).status, 404);
const explorer = list.runs.find(run => run.config.runtime_version === 'explorer-v1');
if (explorer) {
  assert.equal((await request('/v1/runs/' + explorer.run_id + '/graph', false)).status, localDevelopment?200:401);
  const graph = await (await request('/v1/runs/' + explorer.run_id + '/graph')).json();
  assert.equal(graph.coverage_complete, false);
  assert.ok(Array.isArray(graph.states) && Array.isArray(graph.edges) && Array.isArray(graph.decisions));
}
assert.equal((await request('/v1/runs/' + randomUUID() + '/graph')).status, 404);

// This temporary schema probe has no actions or evidence objects.
const foreignRun = randomUUID(), foreignWorkspace = randomUUID();
await postgres(`INSERT INTO runtime_runs(run_id,workspace_id,user_id,target_url,lifecycle,config)
VALUES(${sqlString(foreignRun)},${sqlString(foreignWorkspace)},${sqlString(randomUUID())},'http://127.0.0.1:1/scope-probe','completed','{"purpose":"api_scope_probe","training_status":"excluded_fixture"}');`);
try {
  assert.equal((await request('/v1/runs/' + foreignRun)).status, 404);
  assert.equal((await request('/v1/runs/' + foreignRun + '/graph')).status, 404);
  const scoped = await (await request('/v1/runs')).json();
  assert.ok(scoped.runs.every(run => run.run_id !== foreignRun));
} finally {
  await postgres(`DELETE FROM runtime_runs WHERE run_id=${sqlString(foreignRun)} AND workspace_id=${sqlString(foreignWorkspace)};`);
}
console.log(JSON.stringify({ status: 'passed', run_id: runId, access_mode:accessMode, checks: ['health_and_readiness', 'configured_access_mode', 'cross_origin_and_bad_token_rejected', 'run_and_capture_relationships', 'invalid_and_missing_ids', 'workspace_filter', 'model_configuration_and_usage_scope', 'explicit_unimplemented_capabilities'] }, null, 2));
