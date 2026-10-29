// Real API/worker/storage integration. Run only under compose.model-test.yaml;
// secrets stay in memory or an isolated 0600 temporary credential file.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,stat,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseEnv} from 'node:util';
import {fileURLToPath} from 'node:url';
import {root,postgres,sqlString,clients} from './local-clients.mjs';
const base='http://127.0.0.1:18080', checks=[], credentials=[], jobs=[];
const env=parseEnv(await readFile(new URL('../.env',import.meta.url),'utf8'));
const operator=env.SCOUT_API_TOKEN;
const hash=s=>createHash('sha256').update(s).digest('hex');
async function request(path,token,body){return fetch(base+path,{method:body===undefined?'GET':'POST',headers:{...(token?{Authorization:'Bearer '+token}:{}),'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(15000)});}
async function json(path,token,body,status=200){const response=await request(path,token,body);assert.equal(response.status,status,path);return response.json();}
async function tool(token,name,args={}){const value=await json('/v1/agent/tools/'+name,token,args);assert.equal(value.isError,false,name);return value.structuredContent;}
async function until(check,label){for(let i=0;i<240;i++){const value=await check();if(value)return value;await new Promise(r=>setTimeout(r,250));}throw new Error(label);}
async function workspace(name){const value=await json('/v1/workspaces',operator,{name},201);credentials.push({manager:true,token:value.manager_token,workspace_id:value.workspace_id});return value;}
async function begin(name='Fixture local agent',scopes=['runs:read','runs:write','usage:read']){const verifier=randomUUID()+randomUUID();const value=await json('/v1/agent-connections',null,{agent_name:name,scopes,code_challenge:hash(verifier)});return {...value,verifier};}
async function pair(manager,scopes){const connection=await begin('Fixture scoped agent',scopes);await json(`/v1/agent-connections/${connection.user_code}/decision`,manager,{approve:true});const value=await json('/v1/agent-connections/token',null,{device_code:connection.device_code,code_verifier:connection.verifier});credentials.push({token:value.access_token,agent_id:value.agent_id,workspace_id:value.workspace_id});return value;}
const binary=fileURLToPath(new URL('../apps/api/target/debug/scout-mcp',import.meta.url));
const childEnv={...process.env};for(const name of ['SCOUT_API_TOKEN','SCOUT_API_URL','SCOUT_CREDENTIAL_FILE'])delete childEnv[name];
const temporary=await mkdtemp(join(tmpdir(),'scout-agent-identity-'));
const profile=join(temporary,'profile','credentials.json');let login;
try{
  assert.equal((await json('/v1/model-providers',operator)).test_mode,true,'Refuse live model execution');
  const a=await workspace('Identity fixture A'),b=await workspace('Identity fixture B');
  const pending=await begin();
  const first=await json('/v1/agent-connections/token',null,{device_code:pending.device_code,code_verifier:pending.verifier},202);assert.equal(first.status,'authorization_pending');
  assert.equal((await request('/v1/agent-connections/token',null,{device_code:pending.device_code,code_verifier:pending.verifier})).status,429);
  assert.equal((await request('/v1/agent-connections/token',null,{device_code:pending.device_code,code_verifier:'incorrect_verifier_'.repeat(4)})).status,400);
  await json(`/v1/agent-connections/${pending.user_code}/decision`,a.manager_token,{approve:false});
  assert.equal((await request('/v1/agent-connections/token',null,{device_code:pending.device_code,code_verifier:pending.verifier})).status,403);
  checks.push('pairing_pending_throttle_verifier_and_denial');
  login=spawn(binary,['login','--api-url',base,'--name','Fixture CLI agent','--no-browser','--credential-file',profile],{cwd:root,env:childEnv,stdio:['ignore','pipe','pipe']});
  let output='',errors='';login.stdout.on('data',data=>{output+=data});login.stderr.on('data',data=>{errors+=data});
  const exit=new Promise((resolve,reject)=>{login.once('error',reject);login.once('close',resolve)});
  const code=await until(()=>errors.match(/code=([0-9A-F]{12})/)?.[1],'CLI did not provide a browser approval code');
  const info=await json('/v1/agent-connections/'+code,a.manager_token);assert.equal(info.agent_name,'Fixture CLI agent');
  await json(`/v1/agent-connections/${code}/decision`,a.manager_token,{approve:true});
  assert.equal(await exit,0,'CLI login should save its credential after approval');assert.equal(output,'','No secret or status on MCP stdout');
  const local=JSON.parse(await readFile(profile,'utf8'));assert.equal((await stat(profile)).mode&0o777,0o600);assert.equal((await stat(join(temporary,'profile'))).mode&0o777,0o700);
  assert.ok(!errors.includes(local.access_token),'Credential never printed by login');assert.equal(local.workspace_id,a.workspace_id);
  credentials.push({token:local.access_token,agent_id:local.agent_id,workspace_id:local.workspace_id});
  const agent=local.access_token,teammate=(await pair(a.manager_token)).access_token,other=(await pair(b.manager_token)).access_token;
  const reader=await pair(a.manager_token,['runs:read']);
  const stored=JSON.parse(await postgres(`SELECT json_build_object('hashed',token_sha256=${sqlString(hash(agent))},'raw_stored',position(${sqlString(agent)} in row_to_json(c)::text)>0) FROM workspace_credentials c WHERE agent_id=${sqlString(local.agent_id)}::uuid;`));
  assert.equal(stored.hashed,true);assert.equal(stored.raw_stored,false);
  const identity=await tool(agent,'scout_whoami');assert.equal(identity.agent_id,local.agent_id);assert.equal(identity.workspace_id,a.workspace_id);
  assert.equal((await json('/v1/agents',a.manager_token)).agents.length,3);
  checks.push('real_CLI_browser_pairing_private_file_hash_only_storage_and_persistent_identity');
  for(const [path,body] of [['/v1/browser-jobs',{job_id:randomUUID(),kind:'explore',target_url:'http://exploration-fixture:8082/branches'}],['/v1/exploration-settings',{}],['/v1/workspaces',{name:'forbidden'}],['/v1/model-requests',{}],['/v1/actions/'+randomUUID()+'/reviews',{}]])assert.equal((await request(path,reader.access_token,body)).status,403,path);
  for(const path of ['/v1/operations','/v1/model-requests/'+randomUUID(),'/v1/browser-access/'+randomUUID()+'/screen','/v1/agents'])assert.equal((await request(path,reader.access_token)).status,403,path);
  const noWrite=await json('/v1/agent/tools/scout_start_exploration',reader.access_token,{job_id:randomUUID(),url:'http://exploration-fixture:8082/branches'},403);assert.equal(noWrite.structuredContent.http_status,403);
  checks.push('read_only_scopes_and_human_operator_boundaries');
  await json('/v1/exploration-settings',a.manager_token,{request_id:randomUUID(),expected_revision:0,provider:'openrouter',model:'scout-explorer-fixture:free',max_actions:2,viewport_profile:'mobile',free_only:true,auto_reproduce:false,max_auto_reproductions:1,max_auto_replay_actions:2},201);
  const job_id=randomUUID(),project_id=randomUUID(),task_id=randomUUID();jobs.push({id:job_id,token:agent});
  const admission=await tool(agent,'scout_start_exploration',{job_id,url:'http://exploration-fixture:8082/branches',project_id,task_id,auth_mode:'public'});
  assert.equal(admission.job.agent_id,local.agent_id);assert.equal(admission.job.workspace_id,a.workspace_id);
  const job=await until(async()=>{const {job}=await json('/v1/browser-jobs/'+job_id,agent);return ['queued','running'].includes(job.status)?null:job;},'Workspace browser job did not settle');
  assert.equal(job.status,'completed','Workspace browser execution must complete');
  const run=await json('/v1/runs/'+job.run_id,teammate);assert.equal(run.run.workspace_id,a.workspace_id);assert.equal(run.run.config.submitted_by_agent_id,local.agent_id);
  assert.ok(run.captures.length>0);assert.ok(run.model_calls.length>0);assert.ok(run.model_requests.every(r=>r.workspace_id===a.workspace_id&&r.agent_id===local.agent_id));
  for(const capture of run.captures)assert.ok(capture.object_key.startsWith('workspace/'+a.workspace_id+'/'));
  const page=await tool(teammate,'scout_list_sessions',{domain:'EXPLORATION-FIXTURE',task_id,project_id,agent_id:local.agent_id,limit:1});assert.equal(page.total,1);assert.equal(page.sessions[0].run_id,job.run_id);
  assert.equal((await tool(other,'scout_list_sessions',{domain:'exploration-fixture'})).total,0);
  const digest=await tool(agent,'scout_get_domain_summary',{domain:'exploration-fixture'});assert.equal(digest.summary_scope.historical_only,true);
  const usage=await tool(agent,'scout_usage');assert.ok(usage.by_agent.some(row=>row.agent_id===local.agent_id&&row.attempts>0));
  checks.push('workspace_scoped_worker_model_calls_evidence_and_domain_task_project_history');
  const capture=run.captures.find(c=>c.status==='available'),artifact=run.artifacts.find(a=>a.status==='available');
  const paths=[`/v1/browser-jobs/${job_id}`,`/v1/browser-jobs/${job_id}/progress`,`/v1/browser-jobs/${job_id}/report`,`/v1/runs/${job.run_id}`,`/v1/runs/${job.run_id}/graph`,`/v1/runs/${job.run_id}/events`,`/v1/runs/${job.run_id}/progress`,`/v1/runs/${job.run_id}/report`,`/v1/captures/${capture.capture_id}`,`/v1/captures/${capture.capture_id}/image`,`/v1/artifacts/${artifact.artifact_id}/content`];
  for(const path of paths)assert.equal((await request(path,other)).status,404,path);
  assert.equal((await request(`/v1/model-requests/${run.model_requests[0].request_id}`,b.manager_token)).status,404);
  const denied=await json('/v1/agent/tools/scout_read_evidence',other,{run_id:job.run_id,capture_id:capture.capture_id},404);assert.equal(denied.isError,true);assert.equal(denied.structuredContent.http_status,404);
  for(const path of [`/v1/browser-jobs/${job_id}/cancel`,`/v1/runs/${job.run_id}/cancel`,`/v1/runs/${job.run_id}/automatic-reproductions/cancel`])assert.equal((await request(path,other,{})).status,404,path);
  checks.push('cross_workspace_reports_images_artifacts_models_and_mutations_are_denied');
  const bridge=spawn(binary,['--credential-file',profile],{cwd:root,env:childEnv,stdio:['pipe','pipe','pipe']});let bridgeOutput='',bridgeErrors='';bridge.stdout.on('data',c=>{bridgeOutput+=c});bridge.stderr.on('data',c=>{bridgeErrors+=c});
  bridge.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'identity-integration',version:'1'}}})+'\n');
  await until(()=>bridgeOutput.includes('"id":1'),'Stdio initialize did not reply');
  bridge.stdin.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'scout_whoami',arguments:{}}})+'\n');
  const reply=await until(()=>{try{return bridgeOutput.trim().split('\n').map(line=>JSON.parse(line)).find(value=>value.id===2)}catch{return null}},'Stdio bridge did not return its paired identity');
  assert.equal(reply.result.structuredContent.agent_id,local.agent_id);assert.ok(!bridgeOutput.includes(agent)&&!bridgeErrors.includes(agent));bridge.kill();
  const mismatched=spawn(binary,['--credential-file',profile,'--api-url','https://another-server.example'],{cwd:root,env:childEnv,stdio:['ignore','pipe','pipe']});mismatched.stdout.resume();mismatched.stderr.resume();const mismatchExit=await new Promise((resolve,reject)=>{mismatched.once('error',reject);mismatched.once('close',resolve)});assert.notEqual(mismatchExit,0);
  checks.push('stdio_uses_saved_identity_and_rejects_another_server_before_network');
  const {clickhouse,s3}=await clients();s3.destroy();
  await until(async()=>Number((await clickhouse(`SELECT count() FROM scout.identity_audit_current WHERE workspace_id='${a.workspace_id}' AND agent_id='${local.agent_id}' FORMAT TabSeparated`)).trim())>0,'Identity audit outbox did not reach ClickHouse');
  await until(async()=>Number((await clickhouse(`SELECT count() FROM scout.agent_model_usage WHERE workspace_id='${a.workspace_id}' AND agent_id='${local.agent_id}' FORMAT TabSeparated`)).trim())>0,'Agent usage attribution did not reach ClickHouse');
  checks.push('ClickHouse_identity_and_agent_model_usage_attribution');
  await json(`/v1/agents/${reader.agent_id}/revoke`,a.manager_token,{});assert.equal((await request('/v1/identity',reader.access_token)).status,401);
  const logout=spawn(binary,['logout','--credential-file',profile],{cwd:root,env:childEnv,stdio:['ignore','ignore','pipe']});logout.stderr.resume();assert.equal(await new Promise((resolve,reject)=>{logout.once('error',reject);logout.once('close',resolve)}),0);assert.equal((await request('/v1/identity',agent)).status,401);assert.equal(await stat(profile).then(()=>true,()=>false),false);
  checks.push('revocation_and_logout_remove_future_access_without_erasing_evidence');
  await mkdir(join(root,'artifacts/identity'),{recursive:true});
  await writeFile(join(root,'artifacts/identity/verification.json'),JSON.stringify({status:'passed',checked_at:new Date().toISOString(),checks,run_id:job.run_id,model_mode:'protocol_fixture',workspace_count:2,scope:'private_workspace_identity_and_pairing',public_sharing:false},null,2)+'\n');
  console.log(JSON.stringify({status:'passed',checks,run_id:job.run_id,model_mode:'protocol_fixture'},null,2));
}finally{
  login?.kill();
  for(const job of jobs)await request('/v1/browser-jobs/'+job.id+'/cancel',job.token,{}).catch(()=>{});
  for(const credential of credentials.filter(c=>!c.manager))await request('/v1/agents/'+credential.agent_id+'/revoke',credential.token,{}).catch(()=>{});
  for(const credential of credentials.filter(c=>c.manager))await postgres(`UPDATE workspace_credentials SET revoked_at=now() WHERE workspace_id=${sqlString(credential.workspace_id)}::uuid;`).catch(()=>{});
  await rm(temporary,{recursive:true,force:true});
}
