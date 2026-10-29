import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import {fileURLToPath} from 'node:url';
import {root, sha256, postgres, sqlString} from './local-clients.mjs';

const env = parseEnv(await readFile(new URL('../.env', import.meta.url), 'utf8'));
const protocol = '2025-11-25', normal = process.argv.includes('--normal-mode');
const headers = {Authorization:'Bearer '+env.SCOUT_API_TOKEN, 'Content-Type':'application/json'};
const checks = [], jobs = [];
let sequence = 0;
const request = (path, body, extra={}) => fetch('http://127.0.0.1:18080'+path, {
  method:body===undefined?'GET':'POST', headers:{...headers,...extra},
  body:body===undefined?undefined:JSON.stringify(body), redirect:'error', signal:AbortSignal.timeout(20000),
});
const get = async path => {const r=await request(path);assert.equal(r.status,200,path);return r.json();};
async function rpc(method, params={}, extra={}) {
  const id=++sequence;
  const response=await request('/mcp',{jsonrpc:'2.0',id,method,params},{
    Accept:'application/json, text/event-stream','Mcp-Protocol-Version':protocol,...extra,
  });
  assert.equal(response.status,200,'MCP HTTP status for '+method);
  assert.equal(response.headers.get('cache-control'),'no-store');
  const value=await response.json();assert.equal(value.id,id);assert.equal(value.jsonrpc,'2.0');return value;
}
const invoke = async (name,args={}) => {
  const response=await rpc('tools/call',{name,arguments:args});
  assert.ok(!response.error,'Unexpected JSON-RPC error for '+name);
  return response.result;
};
const call = async (name,args={}) => {
  const result=await invoke(name,args);
  assert.equal(result.isError,false,name+': '+JSON.stringify(result.structuredContent));
  return result.structuredContent;
};
const until = async (check,message) => {
  for(let i=0;i<180;i++){const result=await check();if(result)return result;await new Promise(r=>setTimeout(r,250));}
  throw new Error(message);
};
const settled = id => until(async()=>{
  const {job}=await call('scout_get_job',{job_id:id});
  return ['queued','running'].includes(job.status)?null:job;
},'Agent-submitted browser job did not settle.');
const docker = args => new Promise((resolve,reject)=>{
  const child=spawn('docker',['compose',...args],{cwd:root,stdio:['ignore','ignore','inherit']});
  child.on('error',reject);child.on('close',code=>code===0?resolve():reject(new Error('Agent fixture worker operation failed.')));
});
const counts = async () => JSON.parse(await postgres(
  "SELECT json_build_object('requests',(SELECT count(*) FROM model_requests),'calls',(SELECT count(*) FROM model_calls),'actions',(SELECT count(*) FROM runtime_actions));"
));
const values = s => ({
  provider:s.provider,model:s.model,max_actions:s.maxActions,viewport_profile:s.viewportProfile,
  free_only:s.freeOnly,auto_reproduce:s.autoReproduce,max_auto_reproductions:s.maxAutoReproductions,
  max_auto_replay_actions:s.maxAutoReplayActions,
});
async function saveSettings(settings) {
  const current=await get('/v1/exploration-settings');
  const r=await request('/v1/exploration-settings',{request_id:randomUUID(),expected_revision:current.revision,...settings});
  assert.equal(r.status,201,'Save/restore fixture defaults');return r.json();
}
async function inspect(report) {
  const run_id=report.run.run_id, summary=await call('scout_get_run',{run_id});
  assert.equal(summary.run.run_id,run_id);assert.equal(summary.actions.length,report.actions.length);
  assert.equal(summary.coverage_complete,false);assert.deepEqual(summary.model_usage,report.model_usage);
  assert.equal(summary.evidence.captures,report.captures.length);
  for(const repro of summary.reproductions)assert.ok(!('source_snapshot' in repro));
  const graph=await call('scout_get_graph',{run_id,limit:1});
  const rawGraph=await get('/v1/runs/'+run_id+'/graph');
  for(const key of ['states','edges','frontier','decisions']){
    assert.equal(graph[key].total,rawGraph[key].length);assert.equal(graph[key].items.length,Math.min(rawGraph[key].length,1));
    assert.equal(graph[key].has_more,rawGraph[key].length>1);
  }
  const nextGraph=await call('scout_get_graph',{run_id,offset:1,limit:1});
  assert.deepEqual(nextGraph.states.items,rawGraph.states.slice(1,2));
  const events=[];let after_seq=0,page;
  do {
    page=await call('scout_get_events',{run_id,after_seq,limit:2});
    assert.ok(page.events.every(e=>e.seq>after_seq));events.push(...page.events);
    assert.ok(!page.has_more||page.next_after_seq>after_seq);after_seq=page.next_after_seq;
  }while(page.has_more);
  assert.deepEqual(events.map(e=>e.event_id),report.events.map(e=>e.event_id));
  const tail=await call('scout_get_events',{run_id,after_seq,limit:2});
  assert.equal(tail.events.length,0);assert.equal(tail.next_after_seq,after_seq);assert.equal(tail.has_more,false);
  assert.equal((await request('/v1/runs/'+run_id+'/events?after_seq=-1')).status,400);
  const restPage=await get('/v1/runs/'+run_id+'/events?limit=2');
  assert.deepEqual(restPage.events.map(e=>e.event_id),events.slice(0,2).map(e=>e.event_id));
  const action=report.actions.at(-1);
  if(action){
    const detail=await call('scout_get_action',{run_id,action_id:action.action_id});
    assert.deepEqual(detail.action,action);
    assert.ok(detail.captures.length>0);
    assert.ok(detail.captures.every(c=>!('controls' in c.observation)&&!('dom' in c.observation)));
    const missing=await invoke('scout_get_action',{run_id,action_id:randomUUID()});assert.equal(missing.structuredContent.http_status,404);
  }
  const capture=report.captures.find(c=>c.status==='available');
  assert.ok(capture,'A recorded PNG is needed for the agent evidence test.');
  const image=await invoke('scout_read_evidence',{run_id,capture_id:capture.capture_id});
  assert.equal(image.isError,false);
  const block=image.content.find(c=>c.type==='image');assert.equal(block.mimeType,'image/png');
  assert.equal(sha256(Buffer.from(block.data,'base64')),capture.sha256);
  assert.equal(image.structuredContent.evidence_id,capture.capture_id);
  assert.equal(Buffer.from(block.data,'base64').length,image.structuredContent.byte_length);
  const artifact=report.artifacts.find(a=>a.status==='available'&&a.object_key.endsWith('.json')&&a.byte_length<120000);
  assert.ok(artifact,'A recorded JSON artifact is needed for the agent evidence test.');
  const evidence=await call('scout_read_evidence',{run_id,artifact_id:artifact.artifact_id});
  assert.equal(evidence.mime_type,'application/json');
  const raw=await get('/v1/artifacts/'+artifact.artifact_id+'/content');assert.deepEqual(evidence.data,raw);
  checks.push('compact_run_action_graph_and_cursor_reads','verified_PNG_image_block_and_JSON_artifact');
}
async function stdio(start=null) {
  const childEnv={...process.env};delete childEnv.SCOUT_API_TOKEN;
  const child=spawn(fileURLToPath(new URL('../apps/api/target/debug/scout-mcp',import.meta.url)),[
    '--env-file',fileURLToPath(new URL('../.env',import.meta.url)),
  ],{cwd:root,env:childEnv,stdio:['pipe','pipe','pipe']});
  const pending=new Map();let next=0,output='',errors='',protocolFailure;
  child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{errors+=chunk;});
  const lines=createInterface({input:child.stdout});
  lines.on('line',line=>{
    try {const value=JSON.parse(line),key=String(value.id),entry=pending.get(key);
      assert.equal(value.jsonrpc,'2.0');assert.ok(entry,'Unsolicited stdio output');
      pending.delete(key);clearTimeout(entry.timer);entry.resolve(value);
    }catch(error){protocolFailure=error;for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(error);}pending.clear();}
  });
  child.on('error',error=>{protocolFailure=error;});
  const send = (method,params={}) => new Promise((resolve,reject)=>{
    const id=++next,timer=setTimeout(()=>{pending.delete(String(id));reject(new Error('Stdio MCP response timed out.'));},10000);
    pending.set(String(id),{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
  });
  let admitted;
  try {
    const hello=await send('initialize',{protocolVersion:protocol,capabilities:{},clientInfo:{name:'scout-stdio-integration',version:'1'}});
    assert.equal(hello.result.protocolVersion,protocol);
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
    const catalog=await send('tools/list');assert.equal(catalog.result.tools.length,26);
    const [status,id]=await Promise.all([
      send('tools/call',{name:'scout_status',arguments:{}}),
      send('tools/call',{name:'scout_new_request_id',arguments:{}}),
    ]);
    assert.equal(status.result.structuredContent.ready,true);assert.match(id.result.structuredContent.job_id,/^[a-f0-9-]{36}$/);
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Stdio parse error was not returned.')),10000);
      pending.set('null',{resolve:value=>{try{assert.equal(value.error.code,-32700);resolve();}catch(e){reject(e);}},reject,timer});
      child.stdin.write('{invalid-json\n');
    });
    assert.ok(!protocolFailure);
    assert.ok(!output.includes(env.SCOUT_API_TOKEN)&&!errors.includes(env.SCOUT_API_TOKEN),'Credentials leaked into bridge output.');
    assert.equal(errors,'','The bridge must not write logs during normal operation.');
    if(start) {
      const value=await send('tools/call',{name:'scout_start_exploration',arguments:start});
      assert.equal(value.result.isError,false);admitted=value.result.structuredContent;
      assert.equal(admitted.job.job_id,start.job_id);
    }
  }finally {
    for(const entry of pending.values())clearTimeout(entry.timer);
    lines.close();child.stdin.end();child.kill();
  }
  checks.push('real_stdio_initialize_catalog_parallel_calls_and_parse_error');
  return admitted;
}

async function codingReport(raw,job_id=null) {
  const before=await counts(),run_id=raw.run.run_id;
  const progress=await call('scout_get_progress',job_id?{job_id}:{run_id});
  assert.equal(progress.execution_finished,true);assert.equal(progress.run.run_id,run_id);
  assert.equal(progress.counts.actions.recorded,raw.actions.length);
  assert.equal(progress.progress_percent,null);assert.equal(progress.poll_after_ms,null);
  assert.equal((await get('/v1/runs/'+run_id+'/progress')).run.run_id,run_id);
  let page=await call('scout_get_report',{...(job_id?{job_id}:{run_id}),limit:1});
  const all=[],snapshot=page.snapshot.id;
  while(true) {
    assert.equal(page.execution_finished,true);assert.equal(page.report_state,'run_finished');
    assert.equal(page.coverage_complete,false);assert.equal(page.codebase_inspected,false);
    assert.equal(page.snapshot.id,snapshot);assert.match(page.markdown,/Scout coding-agent report/);
    assert.ok(JSON.stringify(page).length<128*1024);
    all.push(...page.issues);
    if(!page.pagination.has_more)break;
    assert.equal(page.pagination.next.name,'scout_get_report');
    page=await call(page.pagination.next.name,page.pagination.next.arguments);
  }
  assert.equal(new Set(all.map(i=>i.action_id)).size,all.length);
  const rest=await get('/v1/runs/'+run_id+'/report?limit=1');
  assert.equal(rest.snapshot.id,snapshot);
  assert.deepEqual(rest.issues,all.slice(0,1));
  if(job_id)assert.equal((await get('/v1/browser-jobs/'+job_id+'/report?limit=1')).snapshot.id,snapshot);
  const withoutChanges=await call('scout_get_report',{run_id,include_changes:false,limit:10});
  assert.ok(withoutChanges.issues.every(i=>i.category!=='observed_change'));
  assert.equal((await invoke('scout_get_report',{run_id,expected_snapshot:'0'.repeat(64)})).structuredContent.http_status,409);
  assert.equal((await request('/v1/runs/'+run_id+'/report?expected_snapshot='+'0'.repeat(64))).status,409);
  for(const item of all) {
    const action=raw.actions.find(a=>a.action_id===item.action_id);
    assert.ok(action);assert.equal(item.expected.result,action.spec.prediction.expected_result??JSON.stringify(action.spec.prediction.expected));
    assert.equal(item.observed.result,action.assessment?.observed_result??action.assessment?.actual??null);
    assert.equal(item.change.changed_pixels,action.comparison?.counts.changed_pixels??null);
    assert.equal(item.investigation.source_location,null);assert.equal(item.investigation.root_cause,null);
    assert.equal(item.evidence.captures.before.capture_id,action.before_capture_id);
    assert.equal(item.evidence.captures.after.capture_id,action.after_capture_id);
    if(item.category==='observed_change')assert.equal(item.repair_objective,null);
  }
  const candidate=all.find(i=>i.category==='suspected_bug');
  if(candidate) {
    const detail=await call('scout_get_issue',{run_id,action_id:candidate.action_id});
    assert.deepEqual(detail,candidate);
    assert.deepEqual(await get('/v1/runs/'+run_id+'/issues/'+candidate.action_id),candidate);
    assert.equal(candidate.repair_objective.target_behavior,candidate.expected.result);
    assert.ok(candidate.reproduction.recorded_steps.length>0);
    assert.equal(candidate.verification.new_job_id_required,true);
    assert.equal(candidate.evidence.captures.before.integrity,'not_fetched_in_report');
    const screenshot=await invoke(candidate.evidence.captures.before.read.name,candidate.evidence.captures.before.read.arguments);
    assert.equal(sha256(Buffer.from(screenshot.content.find(c=>c.type==='image').data,'base64')),candidate.evidence.captures.before.sha256);
  }
  assert.deepEqual(await counts(),before);
  checks.push('progress_and_paged_coding_report_without_inference','expected_actual_locations_path_diagnostics_and_evidence_handoff','report_snapshot_conflict_is_explicit');
  return all;
}

const hello=await rpc('initialize',{protocolVersion:protocol,capabilities:{},clientInfo:{name:'scout-agent-integration',version:'1'}});
assert.equal(hello.result.serverInfo.name,'scout-qa');assert.equal(hello.result.protocolVersion,protocol);
const notification=await request('/mcp',{jsonrpc:'2.0',method:'notifications/initialized'},{Accept:'application/json, text/event-stream','Mcp-Protocol-Version':protocol});
assert.equal(notification.status,202);assert.equal(await notification.text(),'');
const catalog=(await rpc('tools/list')).result.tools;
assert.equal(catalog.length,26);assert.deepEqual((await get('/v1/agent/tools')).tools,catalog);
assert.ok(catalog.every(t=>t.inputSchema.additionalProperties===false));
assert.ok(!catalog.some(t=>t.name.includes('human_review')));
for(const name of ['scout_start_exploration','scout_reproduce_candidate'])assert.equal(catalog.find(t=>t.name===name).annotations.idempotentHint,true);
const plain=await request('/v1/agent/tools/scout_new_request_id',{});
assert.equal(plain.status,200);assert.match((await plain.json()).structuredContent.job_id,/^[a-f0-9-]{36}$/);
for(const Authorization of ['', 'Bearer invalid'])assert.equal((await request('/mcp',{jsonrpc:'2.0',id:1,method:'tools/list'},{Authorization,Accept:'application/json, text/event-stream'})).status,401);
assert.equal((await request('/mcp',{jsonrpc:'2.0',id:1,method:'tools/list'},{Origin:'https://foreign.example',Accept:'application/json, text/event-stream'})).status,403);
assert.equal((await request('/mcp',undefined,{Accept:'text/event-stream'})).status,405);
assert.equal((await request('/v1/agent/tools/scout_missing',{})).status,404);
const invalid=await rpc('tools/call',{name:'scout_new_request_id',arguments:{secret:'not-echoed'}});
assert.equal(invalid.error.code,-32602);assert.ok(!JSON.stringify(invalid).includes('not-echoed'));
const notFound=await invoke('scout_get_job',{job_id:randomUUID()});assert.equal(notFound.isError,true);assert.equal(notFound.structuredContent.http_status,404);
const missingEvents=await invoke('scout_get_events',{run_id:randomUUID()});assert.equal(missingEvents.structuredContent.http_status,404);
const status=await call('scout_status');assert.equal(status.ready,true);
assert.equal(status.agent_interface.external_browser_driver,false);
await call('scout_usage');
const access=await call('scout_access_requests');assert.equal(access.private_login_is_user_only,true);
for(const item of access.requests)assert.deepEqual(Object.keys(item).sort(),['access_id','run_id','status','reason','origin','created_at','expires_at'].sort());
checks.push('HTTP_MCP_and_plain_API_catalog_contract','explicit_MCP_auth_even_with_GUI_bypass','origin_fence_and_strict_arguments','visible_business_errors_and_sign_in_projection');
await stdio();
let source, replay, original;
if(normal) {
  assert.equal((await get('/v1/model-providers')).test_mode,false);
  const before=await counts();
  const recent=await call('scout_list_runs',{limit:50});
  const candidate=recent.runs.find(r=>r.lifecycle==='completed'&&Number(r.summary?.actions)>0);
  assert.ok(candidate,'No existing completed run with recorded actions available for normal-mode read verification.');
  await inspect(await get('/v1/runs/'+candidate.run_id));
  await codingReport(await get('/v1/runs/'+candidate.run_id));
  assert.deepEqual(await counts(),before);
  checks.push('normal_provider_mode_read_only_zero_inference');
}else {
  assert.equal((await get('/v1/model-providers')).test_mode,true,'Never run agent mutations against a real provider in this test.');
  original=values((await get('/v1/exploration-settings')).settings);
  try {
    await saveSettings({...original,provider:'openrouter',model:'openrouter/free',free_only:true,max_actions:6,viewport_profile:'desktop',auto_reproduce:false});
    await until(async()=>(await get('/v1/browser-jobs')).workers.some(w=>w.available),'Browser worker not available.');
    const {job_id}=await call('scout_new_request_id'),spec={job_id,url:'http://exploration-fixture:8082/broken-session?case:delayed',auth_mode:'public',auto_reproduce:false};
    jobs.push(job_id);
    // Admit from a real stdio connection, close it, then reconnect over HTTP.
    const admitted=await stdio(spec);
    assert.equal(admitted.job.job_id,job_id);
    assert.equal(admitted.agent_workflow.report.name,'scout_get_report');
    const early=await call('scout_get_progress',{job_id});
    assert.equal(early.execution_finished,false);assert.ok(early.poll_after_ms>0);
    const partial=await call('scout_get_report',{job_id});
    assert.ok(['partial','not_started'].includes(partial.report_state));
    const retry=await call('scout_start_exploration',spec);assert.equal(retry.reused,true);
    assert.deepEqual(retry.job.settings,admitted.job.settings);
    const conflict=await invoke('scout_start_exploration',{...spec,url:'http://exploration-fixture:8082/working'});
    assert.equal(conflict.structuredContent.http_status,409);
    await until(async()=>(await call('scout_get_progress',{job_id})).execution_finished,'Run did not finish after the submitting agent disconnected.');
    const job=await settled(job_id);assert.equal(job.status,'completed',job.error);
    source=await get('/v1/runs/'+job.run_id);await inspect(source);
    const handoff=await codingReport(source,job_id);
    const broken=handoff.find(i=>i.category==='suspected_bug');
    assert.equal(broken.where.control.name,'Save draft');assert.equal(broken.change.changed_pixels,0);
    assert.match(broken.expected.result,/Saved/);assert.match(broken.observed.result,/Ready/);
    checks.push('stdio_submit_disconnect_HTTP_reconnect_and_partial_progress','zero_pixel_save_failure_is_actionable_for_coding_agent');
    const findings=await call('scout_list_findings',{run_id:job.run_id,status:'needs_review'});
    assert.ok(findings.findings.length>0);
    const finding=findings.findings[0];assert.equal(findings.training_approval,false);assert.equal(finding.human_review,'needs_review');
    const repro={job_id:randomUUID(),source_action_id:finding.action_id};jobs.push(repro.job_id);
    await call('scout_reproduce_candidate',repro);
    const reproduced=await settled(repro.job_id);assert.equal(reproduced.status,'completed',reproduced.error);
    replay=await get('/v1/runs/'+reproduced.run_id);
    const replayReport=await codingReport(replay,repro.job_id);
    assert.ok(replayReport.every(i=>i.finding_source.creates_new_finding===false));
    assert.equal(replay.reproductions[0].result.outcome,'reproduced');assert.equal(replay.reproductions[0].result.confirmed_bug,false);
    assert.equal((await call('scout_list_findings',{run_id:reproduced.run_id})).findings.length,0);
    assert.equal((await call('scout_reproduce_candidate',repro)).reused,true);
    const updated=await call('scout_get_report',{run_id:job.run_id,include_changes:false});
    assert.equal(updated.issues[0].reproduction.fresh_checks[0].result.outcome,'reproduced');
    const healthySpec={job_id:randomUUID(),url:'http://exploration-fixture:8082/working',auth_mode:'public',auto_reproduce:false};
    jobs.push(healthySpec.job_id);await call('scout_start_exploration',healthySpec);
    const healthy=await settled(healthySpec.job_id);
    const healthyRaw=await get('/v1/runs/'+healthy.run_id);
    assert.equal(healthyRaw.run.lifecycle,'completed',healthy.error);
    // App behavior and telemetry delivery are independent outcomes. A recorded
    // delivery failure must be visible to the caller, never hidden as a pass.
    if(healthy.status!=='completed') {
      assert.equal(healthy.status,'failed');assert.match(healthy.error,/ClickHouse export failed/);
      const feedback=await call('scout_get_report',{job_id:healthySpec.job_id});
      assert.ok(feedback.execution_issues.some(e=>e.source==='job'&&e.is_application_bug===false));
      checks.push('telemetry_delivery_failure_reported_separately_from_app_behavior');
    }
    const healthyReport=await codingReport(healthyRaw,healthySpec.job_id);
    assert.ok(healthyReport.some(i=>i.category==='observed_change'));
    assert.ok(healthyReport.every(i=>i.category==='observed_change'&&i.repair_objective===null));
    assert.ok(healthyReport.some(i=>i.observed.result.includes('Saved')));
    checks.push('healthy_save_changes_are_reported_without_repair_advice');
    const afterWork=await counts();
    await call('scout_get_run',{run_id:job.run_id});await call('scout_usage');await call('scout_list_findings',{run_id:job.run_id});
    assert.deepEqual(await counts(),afterWork);
    checks.push('URL_only_explore_poll_and_idempotent_retry','fresh_reproduction_without_duplicate_findings_or_human_confirmation','read_tools_add_no_model_calls');
    const foreignRun=randomUUID(),foreignAction=randomUUID(),foreignCapture=randomUUID(),foreignArtifact=randomUUID();
    await postgres("INSERT INTO runtime_runs(run_id,workspace_id,user_id,target_url,lifecycle,config) VALUES("+sqlString(foreignRun)+","+sqlString(randomUUID())+","+sqlString(randomUUID())+",'http://fixture.invalid/','completed','{}');"+
      "INSERT INTO runtime_actions(action_id,run_id,ordinal,prediction_id,spec,state) VALUES("+sqlString(foreignAction)+","+sqlString(foreignRun)+",1,"+sqlString(randomUUID())+",'{}','completed');"+
      "INSERT INTO runtime_captures(capture_id,run_id,action_id,phase,status,object_key,sha256,byte_length) SELECT "+sqlString(foreignCapture)+","+sqlString(foreignRun)+","+sqlString(foreignAction)+",'before','available',object_key,sha256,byte_length FROM runtime_captures WHERE capture_id="+sqlString(source.captures[0].capture_id)+";"+
      "INSERT INTO runtime_artifacts(artifact_id,run_id,kind,object_key,sha256,byte_length,status) SELECT "+sqlString(foreignArtifact)+","+sqlString(foreignRun)+",kind,object_key,sha256,byte_length,status FROM runtime_artifacts WHERE artifact_id="+sqlString(source.artifacts[0].artifact_id)+";");
    try {
      for(const [name,args] of [
        ['scout_get_run',{run_id:foreignRun}],['scout_get_events',{run_id:foreignRun}],
        ['scout_get_progress',{run_id:foreignRun}],['scout_get_report',{run_id:foreignRun}],
        ['scout_get_issue',{run_id:foreignRun,action_id:foreignAction}],
        ['scout_read_evidence',{run_id:foreignRun,capture_id:foreignCapture}],
        ['scout_read_evidence',{run_id:foreignRun,artifact_id:foreignArtifact}],
        ['scout_read_evidence',{run_id:source.run.run_id,capture_id:foreignCapture}],
        ['scout_read_evidence',{run_id:replay.run.run_id,capture_id:source.captures[0].capture_id}],
      ])assert.equal((await invoke(name,args)).structuredContent.http_status,404,name+' must enforce run ownership and binding');
    }finally {
      await postgres("DELETE FROM runtime_artifacts WHERE run_id="+sqlString(foreignRun)+";DELETE FROM runtime_captures WHERE run_id="+sqlString(foreignRun)+";DELETE FROM runtime_actions WHERE run_id="+sqlString(foreignRun)+";DELETE FROM runtime_runs WHERE run_id="+sqlString(foreignRun)+";");
    }
    checks.push('foreign_workspace_and_wrong_run_evidence_rejected');
    await docker(['stop','browser-worker']);
    const queued={job_id:randomUUID(),url:spec.url,auth_mode:'public'};jobs.push(queued.job_id);
    await call('scout_start_exploration',queued);
    const pending=await call('scout_get_progress',{job_id:queued.job_id});assert.equal(pending.phase,'queued');assert.equal(pending.run,null);
    const notStarted=await call('scout_get_report',{job_id:queued.job_id});assert.equal(notStarted.report_state,'not_started');assert.equal(notStarted.coverage_complete,false);
    const cancelled=await call('scout_cancel_work',{kind:'job',id:queued.job_id});
    assert.equal(cancelled.status,'cancelled');
    assert.equal((await call('scout_cancel_work',{kind:'job',id:queued.job_id})).reused,true);
    assert.equal((await call('scout_get_job',{job_id:queued.job_id})).job.run_id,null);
    assert.equal((await call('scout_start_exploration',queued)).reused,true);
    const noRun=await call('scout_get_report',{job_id:queued.job_id});assert.equal(noRun.report_state,'execution_ended_without_run');
    assert.equal(noRun.progress.phase,'cancelled');assert.equal(noRun.issues.length,0);
    checks.push('durable_queued_cancel_retry_does_not_execute');
  }finally {
    for(const job_id of jobs)await invoke('scout_cancel_work',{kind:'job',id:job_id});
    if(original)await saveSettings(original);
  }
}
const result={status:'passed',verified_at:new Date().toISOString(),mode:normal?'normal_mode_read_only':'simulated_models_real_browser_worker',
  protocol_version:protocol,tool_count:catalog.length,checks,source_run_id:source?.run.run_id,replay_run_id:replay?.run.run_id,
  live_model_calls:0,external_browser_driver:false,complete_MCP_read_audit:false};
const directory=new URL('../artifacts/agent-interface/',import.meta.url);await mkdir(directory,{recursive:true});
await writeFile(new URL(normal?'normal-verification.json':'verification.json',directory),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
