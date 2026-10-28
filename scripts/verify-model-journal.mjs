// Force a settlement failure after a real fixture response is received, then
// prove the fsync'd journal survives restart and settles without another call.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { parseEnv } from 'node:util';
import { spawn } from 'node:child_process';
import { root, postgres, sqlString } from './local-clients.mjs';
const env=parseEnv(await readFile(new URL('../.env',import.meta.url),'utf8'));
const headers={Authorization:`Bearer ${env.SCOUT_API_TOKEN}`,'content-type':'application/json'};
const base='http://127.0.0.1:18080';
const get=async path=>{const r=await fetch(base+path,{headers});assert.equal(r.status,200);return r.json();};
assert.equal((await get('/v1/model-providers')).test_mode,true,'Requires fake-provider mode.');
const id=randomUUID();
const suffix=id.replaceAll('-','');
const functionName='fixture_fail_settle_'+suffix;
const triggerName='fixture_fail_settle_'+suffix;
const spec={request_id:id,provider:'openai',model:`fixture/${id}`,prompt:'case:success Journal recovery check.',max_output_tokens:100};
async function wait(fn,label) {
  const end=Date.now()+30000;
  while(Date.now()<end) { const value=await fn(); if(value)return value; await new Promise(r=>setTimeout(r,150)); }
  throw new Error('Timeout: '+label);
}
function compose(args,input) {
  return new Promise((resolve,reject)=>{
    const p=spawn('docker',['compose','-f','compose.yaml','-f','compose.model-test.yaml',...args],{cwd:root});
    let output=''; p.stdout.on('data',d=>output+=d);p.stderr.on('data',d=>output+=d);
    p.on('error',reject);p.on('close',code=>code===0?resolve(output):reject(new Error(output.slice(-1000))));p.stdin.end(input);
  });
}
const beforeUsage=await get('/v1/usage');
await postgres(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.request_id=${sqlString(id)}::uuid THEN RAISE EXCEPTION 'intentional fixture settlement failure'; END IF; RETURN NEW; END $$;
CREATE TRIGGER ${triggerName} BEFORE UPDATE ON model_calls FOR EACH ROW EXECUTE FUNCTION ${functionName}();`);
try {
  const admitted=await fetch(base+'/v1/model-requests',{method:'POST',headers,body:JSON.stringify(spec)});assert.equal(admitted.status,202);
  await wait(async()=>(await fetch(base+'/readyz',{headers})).status===503,'worker halted after settlement failure');
  const pending=await get('/v1/model-requests/'+id);
  assert.equal(pending.calls.length,1);assert.equal(pending.calls[0].state,'dispatched');
  const callId=pending.calls[0].call_id;
  const journalBytes=await compose(['exec','-T','api','cat',`/data/gateway/${callId}.json`]);
  const journal=JSON.parse(journalBytes);assert.equal(journal.call_id,callId);assert.equal(journal.state,'completed');assert.equal(journal.input_tokens,16);
  await postgres(`DROP TRIGGER ${triggerName} ON model_calls; DROP FUNCTION ${functionName}();`);
  await compose(['restart','api']);
  await wait(async()=>{try{return (await fetch(base+'/readyz',{headers})).status===200;}catch{return false;}},'restart readiness');
  const settled=await get('/v1/model-requests/'+id);
  assert.equal(settled.request.state,'completed');assert.equal(settled.calls.length,1);assert.equal(settled.calls[0].input_tokens,16);
  assert.equal(settled.events.filter(e=>e.event_type==='call_finished').length,1);
  const settledUsage=await get('/v1/usage');
  assert.equal(settledUsage.attempts-beforeUsage.attempts,1);
  assert.equal(settledUsage.known_input_tokens-beforeUsage.known_input_tokens,16);

  // Simulate a process dying after transaction commit but before journal unlink.
  await compose(['exec','-T','api','sh','-c','umask 077; cat > "$1"','sh',`/data/gateway/${callId}.json`],journalBytes);
  await compose(['restart','api']);
  await wait(async()=>{try{return (await fetch(base+'/readyz',{headers})).status===200;}catch{return false;}},'idempotent journal recovery');
  const replayed=await get('/v1/model-requests/'+id);
  assert.equal(replayed.calls.length,1);assert.equal(replayed.events.filter(e=>e.event_type==='call_finished').length,1);
  assert.deepEqual(await get('/v1/usage'),settledUsage);
  const calls=(await (await fetch('http://127.0.0.1:18081/stats')).json()).calls.filter(c=>c.model===spec.model);
  assert.equal(calls.length,1);
  await wait(async()=>{const r=await get('/v1/model-requests/'+id);return r.payloads.every(p=>p.uploaded_at)&&r.events.every(e=>e.exported_at);},'journal evidence export');
  await writeFile(new URL('../artifacts/model-gateway/journal-verification.json',import.meta.url),JSON.stringify({status:'passed',mode:'protocol_fixture',request_id:id,call_id:callId,provider_dispatches:1,checks:['response_retained_on_settlement_failure','journal_recovers_after_restart','post_commit_journal_replay_idempotent','usage_settled_once','no_provider_redispatch']},null,2)+'\n');
  console.log('PASS response journal retained across database settlement failure and restart; duplicate replay does not double-count usage or dispatch again');
} finally {
  await postgres(`DROP TRIGGER IF EXISTS ${triggerName} ON model_calls; DROP FUNCTION IF EXISTS ${functionName}();`);
}
