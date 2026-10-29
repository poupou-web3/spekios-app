// Real HTTP/MCP/Chromium/PostgreSQL/S3/ClickHouse journey with simulated models.
// Test credentials stay in memory and are revoked, never printed or persisted.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {root,postgres,sqlString,clients} from './local-clients.mjs';
const execute=promisify(execFile),base='http://127.0.0.1:18080',checks=[],credentials=[],jobs=[];
const operator=parseEnv(await readFile(new URL('../.env',import.meta.url),'utf8')).SCOUT_API_TOKEN;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function request(path,token,body){return fetch(base+path,{method:body===undefined?'GET':'POST',headers:{...(token?{Authorization:'Bearer '+token}:{}),'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(20000)});}
async function json(path,token=operator,body,status=200){const response=await request(path,token,body);assert.equal(response.status,status,path);return response.json();}
async function tool(name,args={},token=operator){const value=await json('/v1/agent/tools/'+name,token,args);assert.equal(value.isError,false,name+': '+JSON.stringify(value.structuredContent));return value.structuredContent;}
let rpcId=0;
async function mcp(name,args={},token=operator){const response=await fetch(base+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25'},body:JSON.stringify({jsonrpc:'2.0',id:++rpcId,method:'tools/call',params:{name,arguments:args}}),redirect:'error',signal:AbortSignal.timeout(20000)});assert.equal(response.status,200);const {result,error}=await response.json();assert.equal(error,undefined);assert.equal(result.isError,false,name+': '+JSON.stringify(result.structuredContent));return result.structuredContent;}
async function until(check,label){for(let i=0;i<360;i++){const value=await check();if(value)return value;await new Promise(r=>setTimeout(r,300));}throw new Error(label);}
async function pair(manager,scopes){const verifier=randomUUID()+randomUUID();const begin=await json('/v1/agent-connections',null,{agent_name:'Fix journey test agent',scopes,code_challenge:hash(verifier)});await json(`/v1/agent-connections/${begin.user_code}/decision`,manager,{approve:true});const credential=await json('/v1/agent-connections/token',null,{device_code:begin.device_code,code_verifier:verifier});credentials.push({...credential,manager});return credential;}
async function settled(id,token=operator){return until(async()=>{const {job}=await json('/v1/browser-jobs/'+id,token);return ['queued','running'].includes(job.status)?null:job;},'Browser job did not settle: '+id);}
let workerStopped=false,foreign;
try{
  assert.equal((await json('/v1/model-providers')).test_mode,true,'Refuse to run against live models');
  const agent=await pair(operator,['runs:read','runs:write','usage:read']),reader=await pair(operator,['runs:read']);
  foreign=await json('/v1/workspaces',operator,{name:'Fix journey isolation fixture'},201);const outsider=await pair(foreign.manager_token,['runs:read','runs:write']);
  const sourceUrl=`http://exploration-fixture:8082/broken-session?fix_journey=${randomUUID()}`;
  const sourceJob=randomUUID();jobs.push(sourceJob);
  await tool('scout_start_exploration',{job_id:sourceJob,url:sourceUrl,auth_mode:'public',auto_reproduce:false},agent.access_token);
  const source=await settled(sourceJob);assert.equal(source.status,'completed',source.error);
  const original=await json('/v1/runs/'+source.run_id),suspect=original.actions.find(a=>a.assessment?.verdict==='suspect');assert.ok(suspect,'Source should discover Save draft failure');
  const occurrence=original.persistent_issues.find(i=>i.action_id===suspect.action_id);assert.ok(occurrence,'A permanent issue ID is assigned during discovery');
  const issueId=occurrence.issue_id;assert.notEqual(issueId,suspect.action_id);
  const handoff=await tool('scout_get_issue',{issue_id:issueId},agent.access_token);
  assert.equal(handoff.handoff.issue_id,issueId);assert.equal(handoff.original.expected_result,'The draft status changes to Saved.');assert.ok(handoff.original.observed_result.includes('Ready'));
  assert.equal(handoff.handoff.reproduction.recorded_steps.length,suspect.ordinal);assert.equal(handoff.handoff.verification.start_tool,'scout_verify_fix');assert.equal(handoff.handoff.evidence.captures.before.status,'available');
  const report=await tool('scout_get_report',{run_id:source.run_id},agent.access_token);assert.ok(report.issues.some(i=>i.issue_id===issueId));
  const sourceBytes=new Map();for(const capture of original.captures){const r=await request(`/v1/captures/${capture.capture_id}/image`,agent.access_token);assert.equal(r.status,200);sourceBytes.set(capture.capture_id,hash(Buffer.from(await r.arrayBuffer())));assert.equal(sourceBytes.get(capture.capture_id),capture.sha256);}
  checks.push('discovery_assigns_stable_issue_and_complete_coding_agent_handoff');
  const repeatedId=randomUUID();jobs.push(repeatedId);await tool('scout_start_exploration',{job_id:repeatedId,url:sourceUrl,auth_mode:'public',auto_reproduce:false},agent.access_token);assert.equal((await settled(repeatedId)).status,'completed');
  const repeated=(await json('/v1/issues/'+issueId));assert.equal(repeated.issue.occurrence_count,2);assert.equal(repeated.issue.source_run_id,source.run_id);assert.deepEqual(repeated.original,handoff.original);
  checks.push('matching_recorded_occurrences_keep_the_same_issue_without_replacing_original_evidence');
  for(const path of ['/v1/issues/'+issueId,'/v1/issues/'+issueId+'/verifications'])assert.equal((await request(path,outsider.access_token,path.endsWith('/verifications')?{verification_id:randomUUID(),candidate_url:sourceUrl}:undefined)).status,404,path);
  assert.equal((await json('/v1/issues',outsider.access_token)).total,0);
  assert.equal((await request('/v1/issues/'+issueId+'/verifications',reader.access_token,{verification_id:randomUUID(),candidate_url:sourceUrl})).status,403);
  assert.equal((await request('/v1/issues/'+issueId+'/verifications',agent.access_token,{verification_id:randomUUID(),candidate_url:'https://unapproved.example/'})).status,400);
  checks.push('workspace_scope_read_only_agent_and_candidate_origin_boundaries');
  const results=[];
  for(const [path,expected] of [['/fixed-candidate','resolved'],['http://candidate-fixture:8082/preview-editor','resolved'],['/broken-session','still_reproducible'],['/fix-offline','inconclusive'],['/fix-missing','inconclusive'],['/auth/login','blocked'],['/uncertain-candidate','inconclusive'],['/provider-outage','inconclusive']]){
    const verification_id=randomUUID(),candidate_url=(path.startsWith('http')?path:'http://exploration-fixture:8082'+path)+'?fix_journey='+sourceJob; jobs.push(verification_id);
    const args={issue_id:issueId,verification_id,candidate_url,deployment_ref:'Fixture candidate '+path,auth_mode:'public'};
    const receipt=await mcp('scout_verify_fix',args,agent.access_token);assert.equal(receipt.verification_id,verification_id);assert.equal(receipt.issue_id,issueId);assert.equal(receipt.next.disconnect_cancels_work,false);
    const again=await tool('scout_verify_fix',args,agent.access_token);assert.equal(again.reused,true);assert.equal(again.job.job_id,receipt.job.job_id);
    const conflict=await request('/v1/issues/'+issueId+'/verifications',agent.access_token,{verification_id,candidate_url:candidate_url+'-changed'});assert.equal(conflict.status,409);
    await settled(verification_id);const api=await json('/v1/issue-verifications/'+verification_id),mcpResult=await mcp('scout_get_verification',{verification_id},agent.access_token);assert.deepEqual(mcpResult,api);assert.equal(api.verification.outcome,expected,JSON.stringify(api.verification.result));
    const check=api.verification;assert.equal(check.verification_id,verification_id);assert.equal(check.issue_id,issueId);assert.equal(check.result.verified_fixed_globally,false);assert.equal(check.candidate_url,candidate_url);
    assert.equal((await request('/v1/issue-verifications/'+verification_id,outsider.access_token)).status,404);
    if(check.run_id){const candidate=await json('/v1/runs/'+check.run_id);assert.notEqual(candidate.run.run_id,source.run_id);assert.notEqual(candidate.run.config.worker_id,original.run.config.worker_id);assert.equal(candidate.run.config.fix_verification.issue_id,issueId);assert.equal(candidate.persistent_issues.length,0,'Candidate checks do not create original findings');
      assert.equal(candidate.run.config.viewport_profile,original.run.config.viewport_profile);assert.ok(candidate.model_requests.every(r=>r.agent_id===agent.agent_id));
      assert.ok(candidate.captures.every(c=>!sourceBytes.has(c.capture_id)));assert.equal(Number(check.usage.attempts),candidate.model_calls.length);assert.equal(check.usage.run_id,candidate.run.run_id);
      const candidateReport=await tool('scout_get_report',{job_id:verification_id},agent.access_token);assert.equal(candidateReport.fix_verification.outcome,expected);
      if(expected==='resolved'||expected==='still_reproducible'){assert.equal(candidate.actions.length,suspect.ordinal);assert.equal(check.result.evidence_verified,true);assert.equal(check.result.candidate_capture_ids.length,2);assert.deepEqual(check.result.source_capture_ids,[suspect.before_capture_id,suspect.after_capture_id]);
        for(const action of candidate.actions){const sourceAction=original.actions.find(a=>a.action_id===action.spec.replay_source_action_id);assert.equal(action.spec.prediction.expected_result,sourceAction.spec.prediction.expected_result);}
        for(const id of check.result.candidate_capture_ids){const c=candidate.captures.find(c=>c.capture_id===id);const r=await request('/v1/captures/'+id+'/image',reader.access_token);assert.equal(r.status,200);assert.equal(hash(Buffer.from(await r.arrayBuffer())),c.sha256);}
      }
      if(path==='/fix-missing')assert.equal(candidate.actions.at(-1).dispatched_at,null,'Drift prevents dispatch');
      if(path==='/auth/login')assert.ok(!candidate.captures.some(c=>c.observation.url.includes('/auth/login')),'Private login is not recorded');
    }
    results.push({verification_id,candidate_url,outcome:expected,run_id:check.run_id});checks.push('candidate_'+path.slice(1).replaceAll('-','_')+'_'+expected);console.log(`Verified ${expected}: ${path}`);
  }
  const sourceAfter=await json('/v1/runs/'+source.run_id);assert.deepEqual(sourceAfter.actions,original.actions);assert.deepEqual(sourceAfter.captures,original.captures);assert.deepEqual(sourceAfter.events,original.events);
  for(const c of sourceAfter.captures){const r=await request('/v1/captures/'+c.capture_id+'/image',operator);assert.equal(hash(Buffer.from(await r.arrayBuffer())),sourceBytes.get(c.capture_id));}
  checks.push('original_predictions_actions_and_evidence_remain_unchanged_after_candidate_checks');
  const reviewId=randomUUID();await json('/v1/actions/'+suspect.action_id+'/reviews',operator,{review_id:reviewId,expected_revision:0,disposition:'needs_review',rationale:'Fixture review keeps the original hypothesis separate from candidate verification.',expectation_basis:''},201);
  const reviewed=await json('/v1/issues/'+issueId);assert.equal(reviewed.handoff.human_review.review_id,reviewId);assert.ok(reviewed.history.total>handoff.history.total);
  for(const statement of [
    `UPDATE issues SET snapshot='{}'::jsonb WHERE issue_id=${sqlString(issueId)}::uuid`,
    `UPDATE issue_verifications SET outcome='blocked' WHERE verification_id=${sqlString(results[0].verification_id)}::uuid`,
    `UPDATE issue_events SET event_type='rewritten' WHERE issue_id=${sqlString(issueId)}::uuid`,
  ])await assert.rejects(postgres(statement),/immutable|append-only/);
  checks.push('original_issue_terminal_results_and_event_payloads_are_immutable_and_human_review_stays_separate');
  const first=await json(`/v1/issues/${issueId}?limit=1`);assert.equal(first.verifications.items.length,1);assert.ok(first.verifications.total>=7);assert.equal(first.verifications.pagination.next_offset,1);
  const second=await tool('scout_get_issue',{issue_id:issueId,offset:1,limit:1,expected_revision:first.issue.revision},agent.access_token);assert.notEqual(second.verifications.items[0].verification_id,first.verifications.items[0].verification_id);
  const managerHistory=await json('/v1/issues/'+issueId),agentHistory=await mcp('scout_get_issue',{issue_id:issueId},agent.access_token);assert.deepEqual(managerHistory,agentHistory);
  const listed=await tool('scout_list_issues',{query:sourceUrl},agent.access_token);assert.ok(listed.issues.some(i=>i.issue_id===issueId));
  checks.push('dashboard_and_MCP_share_paged_history_both_evidence_sets_and_usage');
  await execute('docker',['compose','stop','browser-worker'],{cwd:root});workerStopped=true;
  const cancelled=randomUUID();jobs.push(cancelled);await json(`/v1/issues/${issueId}/verifications`,agent.access_token,{verification_id:cancelled,candidate_url:'http://exploration-fixture:8082/fixed-cancelled'},202);await json('/v1/browser-jobs/'+cancelled+'/cancel',agent.access_token,{});
  const cancellation=await tool('scout_get_verification',{verification_id:cancelled},agent.access_token);assert.equal(cancellation.verification.outcome,'inconclusive');assert.equal(cancellation.verification.usage.attempts,0);assert.equal(cancellation.verification.usage.known_input_tokens,null);assert.equal(cancellation.verification.result.verified_fixed_globally,false);
  assert.equal((await request(`/v1/issues/${issueId}?limit=1&offset=1&expected_revision=${first.issue.revision}`,operator)).status,409);
  checks.push('queued_cancellation_never_resolves_an_issue_and_pagination_rejects_mixed_revisions');
  // Simulate a persisted claimed job whose process died before linking a run.
  // The real worker recovery must settle it without executing browser actions.
  const interrupted=randomUUID();jobs.push(interrupted);await json(`/v1/issues/${issueId}/verifications`,agent.access_token,{verification_id:interrupted,candidate_url:'http://exploration-fixture:8082/fixed-interrupted'},202);
  await postgres(`UPDATE browser_jobs SET status='running',started_at=now() WHERE job_id=${sqlString(interrupted)}::uuid;`);
  await execute('docker',['compose','start','browser-worker'],{cwd:root});workerStopped=false;assert.equal((await settled(interrupted)).status,'interrupted');
  const recovery=(await tool('scout_get_verification',{verification_id:interrupted},agent.access_token)).verification;assert.equal(recovery.outcome,'inconclusive');assert.equal(recovery.run_id,null);assert.equal(recovery.usage.attempts,0);
  checks.push('worker_recovery_preserves_inconclusive_without_replaying_abandoned_checks');
  const {clickhouse,s3}=await clients();s3.destroy();await until(async()=>Number((await clickhouse(`SELECT count() FROM scout.issue_events_current WHERE issue_id='${issueId}' FORMAT TabSeparated`)).trim())===Number((await json('/v1/issues/'+issueId)).history.total),'Issue history outbox did not reach ClickHouse');
  checks.push('append_only_issue_history_exported_to_ClickHouse');
  await mkdir(new URL('../artifacts/fix-verification/',import.meta.url),{recursive:true});
  const proof={status:'passed',checked_at:new Date().toISOString(),model_mode:'protocol_fixture',checks,issue_id:issueId,source_run_id:source.run_id,results};await writeFile(new URL('../artifacts/fix-verification/verification.json',import.meta.url),JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof,null,2));
}finally{
  if(workerStopped)await execute('docker',['compose','start','browser-worker'],{cwd:root}).catch(()=>{});
  for(const id of jobs)await request('/v1/browser-jobs/'+id+'/cancel',operator,{}).catch(()=>{});
  for(const c of credentials)await request('/v1/agents/'+c.agent_id+'/revoke',c.manager,{}).catch(()=>{});
  if(foreign)await postgres(`UPDATE workspace_credentials SET revoked_at=now() WHERE workspace_id=${sqlString(foreign.workspace_id)}::uuid;`).catch(()=>{});
}
