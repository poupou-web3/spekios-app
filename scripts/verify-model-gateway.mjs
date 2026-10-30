import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { parseEnv } from 'node:util';
import { root, clients, postgres, getObject, sha256, sqlString } from './local-clients.mjs';

const env = parseEnv(await readFile(new URL('../.env',import.meta.url),'utf8'));
const headers = { Authorization:`Bearer ${env.SCOUT_API_TOKEN}`, 'content-type':'application/json' };
const base = 'http://127.0.0.1:18080';
const get = async path => {
  const r=await fetch(base+path,{headers,signal:AbortSignal.timeout(10000),redirect:'error'});
  assert.equal(r.status,200,`GET ${path} returned ${r.status}`); return r.json();
};
const submit = async (spec, status=202) => {
  const r=await fetch(base+'/v1/model-requests',{method:'POST',headers,body:JSON.stringify(spec),signal:AbortSignal.timeout(10000),redirect:'error'});
  const body=await r.json(); assert.equal(r.status,status,`submit returned ${r.status}: ${body.error ?? ''}`); return body;
};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn, label, timeout=30000) {
  const end=Date.now()+timeout;
  while(Date.now()<end) { const result=await fn(); if(result) return result; await pause(150); }
  throw new Error('Timed out: '+label);
}
const read=id=>get('/v1/model-requests/'+id);
const done=id=>until(async()=>{const v=await read(id);return ['completed','failed','interrupted'].includes(v.request.state)&&v;},'model result');
const stats=async()=> (await (await fetch('http://127.0.0.1:18081/stats')).json()).calls;
const requests=[];
function spec(provider='openrouter',scenario='success',extra={}) {
  const id=randomUUID();
  const value={request_id:id,provider,model:`fixture/${id}:free`,prompt:`case:${scenario} Inspect the fixture.`,max_output_tokens:100,max_attempts:2,...extra};
  requests.push(value); return value;
}
function compose(...args) {
  return new Promise((resolve,reject)=>{
    const child=spawn('docker',['compose','-f','compose.yaml','-f','compose.model-test.yaml',...args],{cwd:root});
    let output=''; child.stdout.on('data',d=>output+=d); child.stderr.on('data',d=>output+=d);
    child.on('error',reject); child.on('close',code=>code===0?resolve():reject(new Error(`Compose ${args[0]} failed: ${output.slice(-1500)}`)));
  });
}
const providers=await get('/v1/model-providers');
assert.equal(providers.test_mode,true,'Refusing to run fixture tests against live model credentials.');
assert.equal(providers.gateway_ready,true);
assert.equal(providers.providers.filter(p=>p.configured).length,4);
const beforeUsage=await get('/v1/usage');
const {s3,clickhouse}=await clients();
const fixture=JSON.parse(await postgres(`SELECT json_build_object('run_id',c.run_id,'action_id',c.action_id,'capture_id',c.capture_id)
FROM runtime_captures c JOIN runtime_runs r USING(run_id) WHERE r.workspace_id='00000000-0000-4000-8000-000000000001' AND r.user_id='00000000-0000-4000-8000-000000000002' AND c.status='available' AND r.cancel_id IS NULL AND r.lifecycle<>'cancelled' ORDER BY c.created_at DESC LIMIT 1;`));
assert.ok(fixture.capture_id,'Run the browser recorder demo first.');

await submit(spec('openrouter','success',{model:'paid/model'}),400);
await submit(spec('openai','success',{endpoint:'https://untrusted.invalid'}),422);
await submit(spec('openai','success',{prompt:env.SCOUT_API_TOKEN}),400);
await submit(spec('openai','success',{run_id:randomUUID()}),404);
await submit(spec('openai','success',{capture_ids:[fixture.capture_id]}),400);
assert.equal((await fetch(base+'/v1/model-requests',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,401);
console.log('PASS admission, auth, free-only policy and evidence scope');

const reports=[];
for(const provider of ['openai','anthropic','openrouter','meta']) {
  const r=spec(provider,'success',{run_id:fixture.run_id,action_id:fixture.action_id,capture_ids:[fixture.capture_id]});
  await submit(r); const report=await done(r.request_id); reports.push(report);
  assert.equal(report.request.state,'completed'); assert.equal(report.calls.length,1);
  assert.equal(report.calls[0].input_tokens,provider==='anthropic'?60:provider==='openrouter'?3:16);
  assert.equal(report.calls[0].output_tokens,provider==='anthropic'?4:provider==='openrouter'?2:5);
  assert.equal(report.calls[0].usage_status,'reported');
  const wire=(await stats()).find(c=>c.model===r.model); assert.equal(wire.images,true); assert.equal(wire.stream,false); assert.equal(wire.max_tokens,100);
  if(provider==='openrouter') { assert.deepEqual(wire.routing.max_price,{prompt:0,completion:0,request:0,image:0}); assert.equal(report.calls[0].cost_usd,0); }
  if(provider==='openai'||provider==='meta') assert.equal(wire.store,false);
  if(provider==='meta') assert.equal(report.calls[0].returned_model,'fixture-meta');
}
console.log('PASS all four provider protocols, screenshot retrieval, token/cache normalization');

const same=spec();
const admissions=await Promise.all(Array.from({length:8},async()=>{
  const r=await fetch(base+'/v1/model-requests',{method:'POST',headers,body:JSON.stringify(same)}); assert.ok([200,202].includes(r.status)); return r.json();
}));
assert.equal(admissions.filter(a=>a.created).length,1);
const sameReport=await done(same.request_id); reports.push(sameReport);
await submit({...same,prompt:'different payload'},409);
assert.equal((await stats()).filter(c=>c.model===same.model).length,1);
assert.equal(sameReport.calls.length,1);
console.log('PASS concurrent idempotent admission and conflicting request rejection');

const retry=spec('openrouter','rate_limit');
await submit(retry); const retryReport=await done(retry.request_id); reports.push(retryReport);
assert.equal(retryReport.calls.length,2); assert.equal(retryReport.request.state,'completed');
assert.equal(retryReport.calls[0].usage_status,'unknown'); assert.equal(retryReport.calls[0].input_tokens,null);
const retryCalls=(await stats()).filter(c=>c.model===retry.model);
assert.ok(retryCalls[1].at-retryCalls[0].at>=950,'Retry-After must be honored.');
console.log('PASS explicit rate-limit retry with distinct attempt IDs and unknown first-attempt usage');

for(const scenario of ['missing_usage','partial_usage','payment','unavailable','invalid','hang','partial_response','oversize','redirect','bad_retry','redact']) {
  const r=spec('openrouter',scenario); await submit(r); const report=await done(r.request_id); reports.push(report);
  assert.equal(report.calls.length,1,scenario+' must not be retried');
  const c=report.calls[0];
  if(scenario==='missing_usage') { assert.equal(c.state,'completed'); assert.equal(c.input_tokens,null); assert.equal(c.usage_status,'unknown'); }
  else if(scenario==='partial_usage') { assert.equal(c.input_tokens,3); assert.equal(c.output_tokens,null); assert.equal(c.usage_status,'partial'); }
  else if(scenario==='redact') { assert.equal(c.output_text,'Do not leak [REDACTED_CREDENTIAL]'); }
  else { assert.notEqual(c.state,'completed'); assert.equal(c.input_tokens,null); }
  if(['hang','partial_response','oversize'].includes(scenario)) assert.equal(c.response_complete,false);
  if(scenario==='oversize') assert.equal(report.payloads.find(p=>p.kind==='response').byte_length,2*1024*1024);
}
console.log('PASS timeouts, partial responses, missing usage, invalid JSON, redaction, response limits and no unsafe retry');

// A client can disappear after admission; the background worker still settles.
const detached=spec('openai','delayed'); await submit(detached); await pause(100);
const detachedReport=await done(detached.request_id); reports.push(detachedReport); assert.equal(detachedReport.request.state,'completed');

// Kill the real API process after the fixture has received the HTTP request.
const interrupted=spec('openai','hang'); await submit(interrupted);
await until(async()=>(await stats()).some(c=>c.model===interrupted.model),'provider dispatch');
await compose('kill','-s','SIGKILL','api');
await compose('up','-d','--no-build','--no-deps','api');
await until(async()=>{try{return (await fetch(base+'/readyz',{headers})).status===200;}catch{return false;}},'gateway recovery');
const interruptedReport=await done(interrupted.request_id); reports.push(interruptedReport);
assert.equal(interruptedReport.calls.length,1); assert.equal(interruptedReport.calls[0].state,'unknown');
assert.equal(interruptedReport.calls[0].error,'process_interrupted_after_dispatch');
assert.equal((await stats()).filter(c=>c.model===interrupted.model).length,1);
await submit(interrupted,200); assert.equal((await read(interrupted.request_id)).calls.length,1);
console.log('PASS real API process kill, durable recovery and no duplicate provider dispatch');

// Neither an S3 nor a ClickHouse outage may erase the committed call record.
await compose('stop','clickhouse','evidence');
try {
  const outage=spec('openai','success'); await submit(outage); const report=await done(outage.request_id); reports.push(report);
  assert.equal(report.request.state,'completed');
  assert.ok(report.payloads.every(p=>p.uploaded_at===null));
  assert.ok(report.events.some(e=>e.exported_at===null));
} finally { await compose('up','-d','--no-build','--wait','--wait-timeout','60','clickhouse','evidence'); }
console.log('PASS S3/ClickHouse outage retains calls and pending export');

for(let i=0;i<reports.length;i++) {
  reports[i]=await until(async()=>{const v=await read(reports[i].request.request_id);return v.payloads.every(p=>p.uploaded_at)&&v.events.every(e=>e.exported_at)&&v;},'evidence export',60000);
  for(const p of reports[i].payloads) {
    const bytes=await getObject(s3,p.object_key);
    assert.equal(bytes.length,p.byte_length); assert.equal(sha256(bytes),p.sha256);
    assert.ok(!bytes.toString().includes('scout_fixture_credential_not_a_real_key'));
    assert.ok(!bytes.toString().includes(env.SCOUT_API_TOKEN));
  }
}

// Simulate a crash after ClickHouse accepted an event but before the outbox ack.
const ids=reports.flatMap(r=>r.events.map(e=>e.event_id));
await postgres(`UPDATE model_events SET exported_at=NULL WHERE event_id IN (${ids.map(sqlString).join(',')});`);
await until(async()=>JSON.parse(await postgres(`SELECT count(*) FROM model_events WHERE event_id IN (${ids.map(sqlString).join(',')}) AND exported_at IS NULL;`))===0,'telemetry replay',30000);
const eventCount=Number((await clickhouse(`SELECT count(*) FROM scout.model_events_current WHERE event_id IN (${ids.map(sqlString).join(',')}) FORMAT TabSeparated`)).trim());
assert.equal(eventCount,ids.length);
const callCount=Number((await clickhouse(`SELECT count(*) FROM scout.model_usage WHERE request_id IN (${reports.map(r=>sqlString(r.request.request_id)).join(',')}) FORMAT TabSeparated`)).trim());
assert.equal(callCount,reports.reduce((n,r)=>n+r.calls.length,0));
const afterUsage=await get('/v1/usage');
const total=reports.flatMap(r=>r.calls);
assert.equal(afterUsage.attempts-beforeUsage.attempts,total.length);
assert.equal((afterUsage.known_input_tokens??0)-(beforeUsage.known_input_tokens??0),total.reduce((n,c)=>n+(c.input_tokens??0),0));
assert.equal((afterUsage.known_output_tokens??0)-(beforeUsage.known_output_tokens??0),total.reduce((n,c)=>n+(c.output_tokens??0),0));
assert.equal(afterUsage.incomplete_usage_attempts-beforeUsage.incomplete_usage_attempts,total.filter(c=>c.usage_status!=='reported').length);
assert.equal(afterUsage.complete,false);
const correlated=await get('/v1/runs/'+fixture.run_id); assert.ok(correlated.model_usage.attempts>=3);
console.log('PASS all payload hashes, credentials excluded, replay deduplication, per-user accounting and run correlation');
await mkdir(new URL('../artifacts/model-gateway/',import.meta.url),{recursive:true});
await writeFile(new URL('../artifacts/model-gateway/verification.json',import.meta.url),JSON.stringify({status:'passed',mode:'protocol_fixture',live_provider_calls:0,verified_at:new Date().toISOString(),requests:reports.map(r=>({request_id:r.request.request_id,state:r.request.state,call_ids:r.calls.map(c=>c.call_id)})),attempts:total.length,events:ids.length,usage_delta:{input_tokens:(afterUsage.known_input_tokens??0)-(beforeUsage.known_input_tokens??0),output_tokens:(afterUsage.known_output_tokens??0)-(beforeUsage.known_output_tokens??0),incomplete_attempts:afterUsage.incomplete_usage_attempts-beforeUsage.incomplete_usage_attempts}},null,2)+'\n');
console.log(`Verified ${reports.length} requests, ${total.length} provider attempts and ${ids.length} durable events. No real model credits used.`);
