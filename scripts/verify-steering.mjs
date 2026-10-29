import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import {postgres,sqlString as q} from './local-clients.mjs';

const env=parseEnv(await readFile(new URL('../.env',import.meta.url),'utf8'));
const headers={Authorization:'Bearer '+env.SCOUT_API_TOKEN,'Content-Type':'application/json'};
const request=(path,body)=>fetch('http://127.0.0.1:18080'+path,{method:body===undefined?'GET':'POST',headers,
  body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(15000)});
const get=async path=>{const r=await request(path);assert.equal(r.status,200,path);return r.json();};
let sequence=0;
const tool=async(name,args)=>{
  const r=await fetch('http://127.0.0.1:18080/mcp',{method:'POST',headers:{...headers,Accept:'application/json, text/event-stream','Mcp-Protocol-Version':'2025-11-25'},
    body:JSON.stringify({jsonrpc:'2.0',id:++sequence,method:'tools/call',params:{name,arguments:args}}),signal:AbortSignal.timeout(15000)});
  assert.equal(r.status,200);const result=await r.json();assert.ok(!result.error,JSON.stringify(result.error));
  assert.equal(result.result.isError,false,JSON.stringify(result.result.structuredContent));return result.result.structuredContent;
};
const runId=randomUUID(),path='/v1/runs/'+runId+'/steering';
const count=()=>postgres('SELECT count(*) FROM model_requests;');
const before=await count();
await postgres(`INSERT INTO runtime_runs(run_id,workspace_id,user_id,target_url,lifecycle,config) VALUES(${q(runId)},'00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','http://exploration-fixture:8082/tree','active','{"runtime_version":"explorer-v1","replay_of":null,"training_status":"excluded_fixture","purpose":"steering_interface_validation"}');`);
try{
  assert.equal((await get(path)).revision,0);
  const first={steering_id:randomUUID(),expected_revision:0,focus:'Focus on search'};
  const r=await request(path,first);assert.equal(r.status,200);assert.equal((await r.json()).submission.status,'pending');
  const retry=await tool('scout_steer_run',{run_id:runId,...first});assert.equal(retry.reused,true);
  const mismatch=await request(path,{...first,focus:'Changed'});assert.equal(mismatch.status,409);
  const conflict=await request(path,{...first,steering_id:randomUUID()});assert.equal(conflict.status,409);
  for(const change of [{...first,steering_id:'00000000-0000-0000-0000-000000000000'},{...first,expected_revision:-1},{...first,focus:'x'.repeat(2001)},{...first,focus:'bad\u0000text'}]){
    assert.equal((await request(path,change)).status,422);
  }
  assert.equal((await request(path,{...first,workspace_id:randomUUID()})).status,422);
  assert.equal((await request(path+'?offset=-1')).status,400);
  assert.equal((await request(path+'?limit=9')).status,400);
  for(let revision=1;revision<32;revision++){
    const reply=await request(path,{steering_id:randomUUID(),expected_revision:revision,focus:'🙂'.repeat(2000)});
    assert.equal(reply.status,200);const saved=await reply.json();assert.equal(saved.revision,revision+1);assert.ok(saved.messages.length<=8);
  }
  const pages=[];let offset=0;
  do{
    const page=await tool('scout_get_steering',{run_id:runId,offset});
    assert.equal(page.revision,32);assert.ok(page.messages.length<=8);pages.push(...page.messages);offset=page.next_offset;
  }while(offset!==null);
  assert.equal(new Set(pages.map(m=>m.steering_id)).size,32);
  const raw=await get('/v1/runs/'+runId);assert.equal(raw.steering.messages.length,32);
  const progress=await tool('scout_get_progress',{run_id:runId});assert.equal(progress.steering.revision,32);assert.equal(progress.steering.messages.length,8);
  const report=await tool('scout_get_report',{run_id:runId});assert.equal(report.steering.messages.length,8);
  assert.equal((await request(path,{steering_id:randomUUID(),expected_revision:32,focus:'Too many'})).status,409);
  await postgres(`UPDATE runtime_runs SET lifecycle='completed',finished_at=now() WHERE run_id=${q(runId)};`);
  const final=await tool('scout_get_steering',{run_id:runId});assert.equal(final.messages.at(-1).status,'not_applied');
  const http=await request('/v1/agent/tools/scout_get_steering',{run_id:runId,offset:24,limit:8});assert.equal(http.status,200);
  assert.equal((await http.json()).structuredContent.messages[0].steering_id,first.steering_id);
  assert.equal(await count(),before,'Steering and reads must not call a model');
  console.log('Verified steering REST, HTTP tool and MCP admission, exact retries, validation, all 32 Unicode messages across pages, terminal acknowledgement and unchanged inference count.');
}finally{
  await postgres(`UPDATE runtime_runs SET lifecycle='completed',finished_at=COALESCE(finished_at,now()) WHERE run_id=${q(runId)} AND lifecycle='active';`);
}
