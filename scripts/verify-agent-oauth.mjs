// Real storage + standard HTTP OAuth/MCP lifecycle. No browser jobs or inference.
// Secrets are held in memory and never included in the verification artifact.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {postgres,sqlString,root,clients} from './local-clients.mjs';
const base='http://127.0.0.1:18080',resource=base+'/mcp',checks=[],workspaces=[],authorizations=[];
const {SCOUT_API_TOKEN:operator}=parseEnv(await readFile(new URL('../.env',import.meta.url),'utf8'));
const hash=s=>createHash('sha256').update(s).digest('hex');
const challenge=s=>createHash('sha256').update(s).digest('base64url');
async function request(path,{token,body,form,method}={}){
  return fetch(base+path,{method:method||(body||form?'POST':'GET'),headers:{...(path==='/mcp'?{Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25'}:{}),...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{}),...(form?{'Content-Type':'application/x-www-form-urlencoded'}:{})},...(body?{body:JSON.stringify(body)}:form?{body:form instanceof URLSearchParams?form:new URLSearchParams(form)}:{}),redirect:'manual',signal:AbortSignal.timeout(15000)});
}
async function json(path,options={},status=200){const response=await request(path,options);assert.equal(response.status,status,path);return response.json();}
async function client(name='Fixture browser agent') {return json('/oauth/register',{body:{client_name:name,redirect_uris:['http://127.0.0.1/callback'],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']}},201);}
async function begin(client,overrides={}){
  const verifier=randomBytes(48).toString('base64url'),state=randomUUID(),redirect='http://127.0.0.1:54321/callback';
  const params={response_type:'code',client_id:client.client_id,redirect_uri:redirect,code_challenge:challenge(verifier),code_challenge_method:'S256',resource,scope:'runs:read runs:write usage:read',state,...overrides};
  const response=await request('/oauth/authorize?'+new URLSearchParams(params));assert.equal(response.status,303,'Authorization returns browser consent, not a token');
  const location=new URL(response.headers.get('location'),base),id=new URLSearchParams(location.hash.slice(1)).get('authorization');assert.match(id,/^[0-9a-f-]{36}$/);authorizations.push(id);
  return {id,verifier,state,redirect,client_id:client.client_id};
}
async function decision(connection,manager,approve=true,scopes){const value=await json(`/v1/oauth/authorizations/${connection.id}/decision`,{token:manager,body:{approve,...(scopes?{scopes}:{})}});return new URL(value.redirect_uri);}
async function exchange(connection,code,extra={}){return request('/oauth/token',{form:{grant_type:'authorization_code',client_id:connection.client_id,code,code_verifier:connection.verifier,redirect_uri:connection.redirect,resource,...extra}});}
async function rpc(token,method,args){const response=await request('/mcp',{token,body:{jsonrpc:'2.0',id:randomUUID(),method,params:method==='initialize'?{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'browser-oauth-integration',version:'1'}}:args}});if(response.status!==200)return {status:response.status};return {status:200,value:await response.json()};}
async function issued(manager,client,scopes){const connection=await begin(client);const callback=await decision(connection,manager,true,scopes);const response=await exchange(connection,callback.searchParams.get('code'));assert.equal(response.status,200);return response.json();}
let managerA,managerB;
const baseline=await postgres('SELECT count(*) FROM model_requests;');
try {
  const unauth=await request('/mcp');assert.equal(unauth.status,401);assert.match(unauth.headers.get('www-authenticate'),/resource_metadata=/);
  const metadata=await json('/.well-known/oauth-protected-resource/mcp');assert.equal(metadata.resource,resource);assert.deepEqual(metadata.authorization_servers,[base]);
  const server=await json('/.well-known/oauth-authorization-server');assert.equal(server.issuer,base);assert.deepEqual(server.code_challenge_methods_supported,['S256']);assert.equal(server.client_id_metadata_document_supported,false);
  const setup=await json('/v1/agent-setup');assert.equal(setup.mcp_url,resource);assert.equal(setup.cloud_reachable,false);
  checks.push('public_discovery_401_challenge_and_nonsecret_user_setup');
  for(const redirect of ['http://evil.example/callback','javascript:alert(1)','https://example.com/#fragment','https://user:secret@example.com/callback'])assert.equal((await request('/oauth/register',{body:{redirect_uris:[redirect]}})).status,400);
  const c=await client('<untrusted> Browser app'),other=await client('Other client');
  for(const [key,value] of [['redirect_uri','https://unregistered.example/callback'],['resource','https://other.example/mcp'],['code_challenge_method','plain'],['scope','workspace:manage']]){
    const params={response_type:'code',client_id:c.client_id,redirect_uri:'http://127.0.0.1:54321/callback',resource,code_challenge:challenge(randomBytes(48).toString('base64url')),code_challenge_method:'S256',[key]:value};
    const response=await request('/oauth/authorize?'+new URLSearchParams(params));assert.equal(response.status,400);assert.equal(response.headers.get('location'),null);
  }
  const duplicate=await request('/oauth/authorize?client_id=a&client_id=b');assert.equal(duplicate.status,400);
  checks.push('DCR_redirect_validation_PKCE_S256_resource_scope_and_duplicate_parameter_checks');
  for(const name of ['Browser approval fixture A','Browser approval fixture B']){const w=await json('/v1/workspaces',{token:operator,body:{name}},201);workspaces.push(w);}
  [managerA,managerB]=workspaces.map(w=>w.manager_token);
  const connection=await begin(c);
  assert.equal((await request(`/v1/oauth/authorizations/${connection.id}`,{token:'invalid_fixture_credential_000000000000'})).status,401);
  const review=await json(`/v1/oauth/authorizations/${connection.id}`,{token:managerA});assert.equal(review.status,'pending');assert.equal(review.agent_name,'<untrusted> Browser app');
  assert.equal((await request(`/v1/oauth/authorizations/${connection.id}/decision`,{token:managerA,body:{approve:true,scopes:['workspace:manage']}})).status,400);
  const callback=await decision(connection,managerA);assert.equal(callback.searchParams.get('state'),connection.state);assert.equal(callback.searchParams.get('iss'),base);
  assert.equal((await request(`/v1/oauth/authorizations/${connection.id}`,{token:managerB})).status,404);
  assert.equal((await request(`/v1/oauth/authorizations/${connection.id}/decision`,{token:managerA,body:{approve:true}})).status,409);
  const code=callback.searchParams.get('code');
  for(const extra of [{code_verifier:'x'.repeat(64)},{client_id:other.client_id},{redirect_uri:'http://127.0.0.1:54322/callback'},{resource:'https://other.example/mcp'}])assert.equal((await exchange(connection,code,extra)).status,400);
  const response=await exchange(connection,code);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  const tokens=await response.json();assert.equal(tokens.token_type,'Bearer');assert.equal(tokens.expires_in,3600);assert.ok(typeof tokens.refresh_token==='string');
  assert.equal((await exchange(connection,code)).status,400);
  const stored=JSON.parse(await postgres(`SELECT to_jsonb(c) FROM workspace_credentials c WHERE token_sha256=${sqlString(hash(tokens.access_token))};`));assert.equal(stored.token_sha256,hash(tokens.access_token));assert.equal(stored.audience,resource);assert.ok(!JSON.stringify(stored).includes(tokens.access_token));
  checks.push('explicit_workspace_consent_exact_callback_state_and_single_use_hashed_credentials');
  assert.equal((await rpc(tokens.access_token,'initialize')).status,200);
  const who=await rpc(tokens.access_token,'tools/call',{name:'scout_whoami',arguments:{}});assert.equal(who.value.result.structuredContent.workspace_id,workspaces[0].workspace_id);const agent=who.value.result.structuredContent.agent_id;
  assert.equal((await request('/v1/identity',{token:tokens.access_token})).status,401,'MCP access token cannot be used for another audience');
  const history=await rpc(tokens.access_token,'tools/call',{name:'scout_list_sessions',arguments:{domain:'example.com'}});assert.equal(history.value.result.structuredContent.total,0);
  assert.equal((await json('/v1/agents',{token:managerB})).agents.length,0);
  checks.push('actual_MCP_initialize_identity_history_and_workspace_audience_isolation');
  const refreshedResponse=await request('/oauth/token',{form:{grant_type:'refresh_token',client_id:c.client_id,refresh_token:tokens.refresh_token,resource}});assert.equal(refreshedResponse.status,200);const refreshed=await refreshedResponse.json();assert.ok(refreshed.refresh_token!==tokens.refresh_token);assert.ok(refreshed.access_token!==tokens.access_token);
  const refreshedWho=await rpc(refreshed.access_token,'tools/call',{name:'scout_whoami',arguments:{}});assert.equal(refreshedWho.value.result.structuredContent.agent_id,agent);
  assert.equal((await json('/v1/agents',{token:managerA})).agents.length,1,'Refresh does not create duplicate agents in the dashboard');
  assert.equal((await request('/oauth/token',{form:{grant_type:'refresh_token',client_id:c.client_id,refresh_token:tokens.refresh_token,resource}})).status,400);
  assert.equal((await rpc(refreshed.access_token,'initialize')).status,401,'Refresh token reuse revokes its grant');
  checks.push('rotating_refresh_preserves_agent_identity_and_reuse_revokes_the_grant');
  const readOnly=await issued(managerA,c,['runs:read']);
  const denied=await rpc(readOnly.access_token,'tools/call',{name:'scout_start_exploration',arguments:{job_id:randomUUID(),url:'https://example.com'}});assert.equal(denied.value.result.isError,true);assert.equal(denied.value.result.structuredContent.http_status,403);
  assert.equal((await request(`/v1/oauth/authorizations/${connection.id}/decision`,{token:readOnly.access_token,body:{approve:true}})).status,401);
  const readWho=await rpc(readOnly.access_token,'tools/call',{name:'scout_whoami',arguments:{}});
  await json('/v1/agents/'+readWho.value.result.structuredContent.agent_id+'/revoke',{token:managerA,body:{}});
  assert.equal((await rpc(readOnly.access_token,'initialize')).status,401);
  assert.equal((await request('/oauth/token',{form:{grant_type:'refresh_token',client_id:c.client_id,refresh_token:readOnly.refresh_token,resource}})).status,400);
  checks.push('read_only_scope_and_browser_disconnect_stop_access_and_refresh');
  const deniedConnection=await begin(c),deniedCallback=await decision(deniedConnection,managerA,false);assert.equal(deniedCallback.searchParams.get('error'),'access_denied');assert.equal(deniedCallback.searchParams.get('state'),deniedConnection.state);assert.equal(deniedCallback.searchParams.has('code'),false);
  const expiring=await begin(c);const expiredCallback=await decision(expiring,managerA);await postgres(`UPDATE oauth_authorizations SET expires_at=now()-interval '1 second' WHERE authorization_id=${sqlString(expiring.id)}::uuid;`);assert.equal((await exchange(expiring,expiredCallback.searchParams.get('code'))).status,400);
  const concurrent=await begin(c),concurrentCallback=await decision(concurrent,managerA);const raced=await Promise.all([exchange(concurrent,concurrentCallback.searchParams.get('code')),exchange(concurrent,concurrentCallback.searchParams.get('code'))]);assert.deepEqual(raced.map(r=>r.status).sort(),[200,400]);
  const concurrentTokens=await raced.find(r=>r.status===200).json();await request('/oauth/revoke',{form:{client_id:c.client_id,token:concurrentTokens.refresh_token}});assert.equal((await rpc(concurrentTokens.access_token,'initialize')).status,401);
  checks.push('denial_expiry_concurrent_code_exchange_and_standard_revocation');
  const audit=JSON.parse(await postgres(`SELECT json_build_object('issued',count(*) FILTER (WHERE outcome='issued'),'reuse_revoked',count(*) FILTER (WHERE outcome='refresh_reuse_revoked'),'revoked',count(*) FILTER (WHERE operation='POST /oauth/revoke' AND outcome='revoked')) FROM identity_audit WHERE workspace_id=${sqlString(workspaces[0].workspace_id)}::uuid;`));
  assert.ok(audit.issued>=4);assert.equal(audit.reuse_revoked,1);assert.equal(audit.revoked,1);
  checks.push('durable_issuance_refresh_reuse_and_revocation_audit_without_secret_payloads');
  const nativeVerifier=randomBytes(48).toString('base64url');
  const nativeConnection=await json('/v1/agent-connections',{body:{agent_name:'Existing native connector fixture',scopes:['runs:read'],code_challenge:hash(nativeVerifier)}});
  await json(`/v1/agent-connections/${nativeConnection.user_code}/decision`,{token:managerA,body:{approve:true}});
  const native=await json('/v1/agent-connections/token',{body:{device_code:nativeConnection.device_code,code_verifier:nativeVerifier}});
  assert.equal((await json('/v1/identity',{token:native.access_token})).workspace_id,workspaces[0].workspace_id);
  assert.equal((await rpc(native.access_token,'initialize')).status,200);
  assert.equal((await request(`/v1/oauth/authorizations/${connection.id}`,{token:native.access_token})).status,403,'A native agent cannot approve peers');
  await json('/v1/agents/'+native.agent_id+'/revoke',{token:native.access_token,body:{}});
  assert.equal((await request('/v1/identity',{token:native.access_token})).status,401);
  checks.push('native_pairing_and_REST_credentials_remain_compatible_without_manager_privileges');
  const {clickhouse,s3}=await clients();s3.destroy();
  let exported=false;
  for(let attempt=0;attempt<60;attempt++){
    exported=Number((await clickhouse(`SELECT count() FROM scout.identity_audit_current WHERE workspace_id='${workspaces[0].workspace_id}' AND operation='POST /oauth/revoke' AND outcome='revoked' FORMAT TabSeparated`)).trim())>0;
    if(exported)break;await new Promise(resolve=>setTimeout(resolve,500));
  }
  assert.ok(exported,'OAuth audit outbox must reach ClickHouse');
  checks.push('OAuth_audit_metadata_reaches_ClickHouse');
  assert.equal(await postgres('SELECT count(*) FROM model_requests;'),baseline,'Connecting does not consume model usage');
  await mkdir(root+'/artifacts/agent-oauth',{recursive:true});await writeFile(root+'/artifacts/agent-oauth/verification.json',JSON.stringify({status:'passed',checked_at:new Date().toISOString(),checks,model_calls_created:0,transport:'streamable_http',auth:'DCR_authorization_code_PKCE_S256_rotating_refresh',scope:'local_protocol_integration_not_vendor_client_certification'},null,2)+'\n');
  console.log(JSON.stringify({status:'passed',checks,model_calls_created:0},null,2));
} finally {
  for(const w of workspaces)await postgres(`UPDATE agent_identities SET revoked_at=COALESCE(revoked_at,now()) WHERE workspace_id=${sqlString(w.workspace_id)}::uuid; UPDATE workspace_credentials SET revoked_at=COALESCE(revoked_at,now()) WHERE workspace_id=${sqlString(w.workspace_id)}::uuid; UPDATE oauth_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE workspace_id=${sqlString(w.workspace_id)}::uuid;`).catch(()=>{});
  for(const id of authorizations)await postgres(`UPDATE oauth_authorizations SET expires_at=LEAST(expires_at,now()),status=CASE WHEN status='pending' THEN 'denied' ELSE status END WHERE authorization_id=${sqlString(id)}::uuid;`).catch(()=>{});
}
