import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile,mkdir,rm,stat,chmod,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {serverOrigin,VERSION} from '../spekios.mjs';

const cli=fileURLToPath(new URL('../spekios.mjs',import.meta.url));
const catalog=JSON.parse(await readFile(new URL('../../../apps/docs/src/data/mcp-tools.json',import.meta.url),'utf8'));
const token='scout_agent_'+'a'.repeat(64),otherToken='scout_agent_'+'b'.repeat(64);
const hash=s=>createHash('sha256').update(s).digest('hex');
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'spekios-cli-')),cwd=join(dir,'project'),config=join(dir,'config');await mkdir(cwd);
  const workspace=randomUUID(),agent=randomUUID(),otherWorkspace=randomUUID(),project=randomUUID();
  const state={approved:false,revoked:false,requests:[],posts:[],accepted:new Map(),pending:null,dropJob:false,dropIdentity:false,denied:false,redirect:null};
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const c of req)chunks.push(c);const raw=Buffer.concat(chunks).toString('utf8'),body=raw?JSON.parse(raw):null;
    state.requests.push({path:req.url,authorization:req.headers.authorization,body});
    const send=(status,data)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));};
    if(req.url==='/v1/agent-connections'){
      state.pending={device:'d'.repeat(64),challenge:body.code_challenge};
      return send(200,{device_code:state.pending.device,user_code:'AABBCCDDEEFF',expires_in:600,interval:5,verification_uri:'/connect'});
    }
    if(req.url==='/v1/agent-connections/token'){
      assert.equal(body.device_code,state.pending.device);assert.equal(hash(body.code_verifier),state.pending.challenge);
      if(state.denied)return send(403,{error:'connection_denied'});
      if(!state.approved)return send(202,{status:'authorization_pending',interval:5});
      if(state.pending.consumed)return send(409,{error:'connection_already_consumed'});
      state.pending.consumed=true;if(state.dropExchange){state.dropExchange=false;return req.socket.destroy();}return send(200,{access_token:token,agent_id:agent,workspace_id:workspace,expires_in:2592000});
    }
    if(state.redirect&&req.url==='/v1/identity'){res.writeHead(302,{location:state.redirect});return res.end();}
    const bearer=req.headers.authorization?.slice(7),second=bearer===otherToken;
    if((bearer!==token&&!second)||state.revoked)return send(401,{error:'identity_required'});
    if(req.url==='/v1/identity'){
      if(state.dropIdentity){state.dropIdentity=false;return req.socket.destroy();}
      return send(200,{agent_id:second?randomUUID():agent,workspace_id:second?otherWorkspace:workspace,principal_kind:'agent',scopes:['runs:read','runs:write','usage:read']});
    }
    if(req.url===`/v1/agents/${agent}/revoke`){state.revoked=true;return send(200,{revoked:true});}
    if(req.url==='/v1/agent/tools')return send(200,catalog);
    const name=req.url.slice('/v1/agent/tools/'.length);state.posts.push({name,body,bearer});
    const result=data=>send(200,{structuredContent:data,content:[{type:'text',text:JSON.stringify(data)}],isError:false});
    if(name==='scout_list_projects')return result({projects:[{project_id:project,label:'Shop'}]});
    if(name==='scout_get_project')return result({project_id:body.project_id,model:{provider:'meta',model:'muse-spark-1.3-contributor'}});
    if(name==='scout_start_exploration'){
      const prior=state.accepted.get(body.job_id);if(prior)assert.deepEqual(body,prior);else state.accepted.set(body.job_id,body);
      if(state.dropJob){state.dropJob=false;return req.socket.destroy();}
      return result({job_id:body.job_id,status:'queued',reused:!!prior});
    }
    if(name==='scout_get_progress')return result({job_id:body.job_id,status:'running',poll_after_ms:5000});
    if(name==='scout_get_report')return result({job_id:body.job_id,pagination:{next:{name:'scout_get_report',arguments:{job_id:body.job_id,offset:10}}},untrusted_app_content:true});
    return result({received:body,untrusted_app_content:true});
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
  async function run(args,extra={}){
    const env={...process.env,SPEKIOS_CONFIG_DIR:config};delete env.SPEKIOS_TOKEN;delete env.SPEKIOS_SERVER;
    Object.assign(env,extra.env);
    const child=spawn(process.execPath,[extra.entry||cli,...args],{cwd:extra.cwd||cwd,env,stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);
    if(extra.input)child.stdin.end(extra.input);else child.stdin.end();
    const code=await new Promise((r,j)=>{child.on('error',j);child.on('exit',r);});
    assert.doesNotMatch(stdout+stderr,new RegExp(token+'|'+otherToken+'|'+'d'.repeat(64)));
    let data;try{data=JSON.parse(stdout);}catch{assert.fail(`Expected one JSON output: ${stdout} ${stderr}`);}
    return {code,data,stdout,stderr};
  }
  const connect=async()=>{
    const login=await run(['--server',origin,'auth','login','--name','Test agent']);assert.equal(login.code,3);
    assert.equal(new URL(login.data.verification_url).hash,'#code=AABBCCDDEEFF');state.approved=true;
    const complete=await run(['auth','complete']);assert.equal(complete.code,0,complete.stdout);return complete;
  };
  return {dir,cwd,config,workspace,agent,project,otherWorkspace,state,origin,run,connect};
}

test('origins are HTTPS or literal loopback; credentials and unsafe URLs are rejected',()=>{
  assert.equal(serverOrigin('https://app.spekios.com'),'https://app.spekios.com');
  assert.equal(serverOrigin('http://[::1]:8080'),'http://[::1]:8080');
  for(const u of ['http://evil.example','https://u:p@example.com','https://example.com/path','https://example.com?key=x','file:///tmp/x','http://localhost.evil.example'])assert.throws(()=>serverOrigin(u));
});

test('agent authenticates by approval, selects project, submits once and follows progress/report',async t=>{
  const f=await fixture(t);
  assert.equal((await f.run(['--version'])).data.version,VERSION);
  assert.equal((await f.run(['--help'])).data.exit_codes[3],'approval, authentication or sign-in required');
  assert.equal((await f.run(['id'])).code,0);
  assert.equal((await f.run(['auth','status'])).code,3);
  await f.run(['--server',f.origin,'auth','login']);
  assert.equal((await f.run(['auth','complete'])).data.status,'authorization_pending');
  f.state.approved=true;const complete=await f.run(['auth','complete']);assert.equal(complete.code,0,complete.stdout);
  const credentialPath=join(f.config,'default','credential.json'),credential=JSON.parse(await readFile(credentialPath,'utf8'));
  assert.equal(credential.workspace_id,f.workspace);assert.equal(credential.access_token,token);
  assert.equal((await stat(credentialPath)).mode&0o777,0o600);assert.equal((await stat(join(f.config,'default'))).mode&0o777,0o700);
  assert.equal((await f.run(['project','list'])).data.data.projects[0].project_id,f.project);
  assert.equal((await f.run(['project','use',f.project])).code,0);
  const context=JSON.parse(await readFile(join(f.cwd,'.spekios.json'),'utf8'));
  assert.equal(context.project_id,f.project);assert.equal(context.workspace_id,f.workspace);assert.ok(!JSON.stringify(context).includes(token));
  const nested=join(f.cwd,'src');await mkdir(nested);
  const id=randomUUID(),start=await f.run(['run','https://shop.example','--job-id',id],{cwd:nested});assert.equal(start.code,0,start.stdout);
  assert.equal(start.data.project_id,f.project);assert.equal(f.state.accepted.get(id).project_id,f.project);
  assert.equal((await f.run(['status',id])).data.data.poll_after_ms,5000);
  assert.equal((await f.run(['report',id])).data.data.untrusted_app_content,true);
  assert.equal((await f.run(['history','--limit','10'])).code,0);
  assert.equal(f.state.posts.at(-1).body.project_id,f.project);
  assert.equal((await f.run(['tools','list'])).data.data.interface_version,1);
  assert.equal((await f.run(['auth','logout'])).code,0);assert.equal(f.state.revoked,true);
  await assert.rejects(readFile(credentialPath),{code:'ENOENT'});
});

test('network uncertainty preserves the exact receipt; retry cannot change funding, project or inputs',async t=>{
  const f=await fixture(t);await f.connect();await f.run(['project','use',f.project]);
  f.state.dropJob=true;
  const first=await f.run(['run','https://shop.example','--provider','meta','--model','muse-spark-1.3-contributor','--key','demo']);
  assert.equal(first.code,5,first.stdout);const id=first.data.error.request_id;assert.ok(id);
  const receiptPath=join(f.config,'default','requests',id+'.json'),receipt=JSON.parse(await readFile(receiptPath,'utf8'));
  assert.equal(receipt.arguments.model.provider_key_id,'demo');assert.equal((await stat(receiptPath)).mode&0o777,0o600);assert.ok(!JSON.stringify(receipt).includes(token));
  await f.run(['project','use',randomUUID()]);
  const retry=await f.run(['retry',id]);assert.equal(retry.code,0,retry.stdout);assert.equal(retry.data.data.reused,true);
  assert.deepEqual(f.state.posts.filter(p=>p.name==='scout_start_exploration').map(p=>p.body),[receipt.arguments,receipt.arguments]);
  const changed=await f.run(['run','https://changed.example','--job-id',id]);assert.equal(changed.data.error.code,'request_id_conflict');
  assert.equal(f.state.accepted.size,1);
});

test('a consumed approval survives loss of the identity verification response',async t=>{
  const f=await fixture(t);await f.run(['auth','login','--server',f.origin]);f.state.approved=true;f.state.dropIdentity=true;
  assert.equal((await f.run(['auth','complete'])).code,5);
  const resumed=await f.run(['auth','complete']);assert.equal(resumed.code,0,resumed.stdout);
  assert.equal(f.state.requests.filter(r=>r.path==='/v1/agent-connections/token').length,1);
});

test('foreign workspace context and foreign server receive no work or bearer forwarding',async t=>{
  const f=await fixture(t);await f.connect();await f.run(['project','use',f.project]);
  const contextPath=join(f.cwd,'.spekios.json'),context=JSON.parse(await readFile(contextPath,'utf8'));
  await writeFile(contextPath,JSON.stringify({...context,workspace_id:randomUUID()}));
  const start=await f.run(['run','https://shop.example']);assert.equal(start.code,4);assert.equal(start.data.error.code,'project_account_mismatch');assert.equal(f.state.accepted.size,0);
  const previous=f.state.requests.length;
  const foreign=await f.run(['--server','https://another.example','usage']);assert.equal(foreign.data.error.code,'server_mismatch');assert.equal(f.state.requests.length,previous);
  const noServer=await f.run(['usage'],{env:{SPEKIOS_TOKEN:otherToken}});assert.equal(noServer.data.error.code,'server_required');
  const envAccount=await f.run(['--server',f.origin,'run','https://shop.example'],{env:{SPEKIOS_TOKEN:otherToken}});assert.equal(envAccount.data.error.code,'project_account_mismatch');
  const logout=await f.run(['auth','logout'],{env:{SPEKIOS_TOKEN:otherToken}});assert.equal(logout.code,2);assert.equal(f.state.revoked,false);
});

test('credentials with broad permissions or symlinks are refused',async t=>{
  const f=await fixture(t);await f.connect();const path=join(f.config,'default','credential.json');
  await chmod(path,0o644);assert.equal((await f.run(['usage'])).data.error.code,'unsafe_file');await chmod(path,0o600);
  const copy=join(f.dir,'copy.json');await writeFile(copy,await readFile(path),{mode:0o600});await rm(path);await symlink(copy,path);
  assert.equal((await f.run(['usage'])).data.error.code,'invalid_state');
});

test('HTTP redirects never forward an agent token',async t=>{
  const f=await fixture(t);await f.connect();let received=0;const trap=createServer((req,res)=>{received++;res.end('{}');});
  await new Promise(r=>trap.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>trap.close(r)));
  f.state.redirect=`http://127.0.0.1:${trap.address().port}/trap`;
  const result=await f.run(['usage']);assert.equal(result.code,5);assert.equal(received,0);
});

test('live tool discovery supports exact stdin/file input, durable mutations and secret-input rejection',async t=>{
  const f=await fixture(t);await f.connect();
  const input={domain:'shop.example',limit:5};
  assert.equal((await f.run(['tools','call','scout_list_sessions','--input','-'],{input:JSON.stringify(input)})).code,0);
  assert.deepEqual(f.state.posts.at(-1).body,input);
  const file=join(f.cwd,'input.json');await writeFile(file,JSON.stringify(input));assert.equal((await f.run(['tools','call','scout_list_sessions','--input','@'+file])).code,0);
  const mutation={kind:'job',id:randomUUID()},result=await f.run(['tools','call','scout_cancel_work','--input',JSON.stringify(mutation)]);
  assert.equal(result.code,0);assert.ok(result.data.request_id);
  assert.deepEqual((await f.run(['retry',result.data.request_id])).data.data.received,mutation);
  const bad=await f.run(['tools','call','scout_list_sessions','--input',JSON.stringify({api_key:'never-store-this'})]);assert.equal(bad.data.error.code,'secret_in_tool_input');
  assert.equal((await f.run(['status',randomUUID(),'--unknown'])).code,2);
});

test('denied approval issues no credential, pending proof never enters output',async t=>{
  const f=await fixture(t);await f.run(['auth','login','--server',f.origin]);f.state.denied=true;
  const r=await f.run(['auth','complete']);assert.equal(r.code,4);assert.equal(r.data.error.code,'connection_denied');
  await assert.rejects(readFile(join(f.config,'default','credential.json')),{code:'ENOENT'});
});

test('installed/symlinked entrypoint works and new projects register on first job',async t=>{
  const f=await fixture(t);const link=join(f.dir,'spekios');await symlink(cli,link);
  assert.equal((await f.run(['--version'],{entry:link})).data.version,VERSION);
  await f.connect();const created=await f.run(['project','init']);assert.equal(created.data.registration,'on_first_job');assert.equal(created.code,0);
  assert.equal((await f.run(['project','init'])).data.error.code,'project_exists');
  assert.equal((await f.run(['run','https://shop.example'])).code,0);
});

test('explicit empty scope, project and key options fail without widening access or falling back',async t=>{
  const f=await fixture(t);
  const empty=await f.run(['auth','login','--server',f.origin,'--scopes','']);assert.equal(empty.data.error.code,'invalid_scopes');
  assert.equal(f.state.requests.filter(r=>r.path==='/v1/agent-connections').length,0);
  assert.equal((await f.run(['--server','','auth','login'])).data.error.code,'invalid_server');
  assert.equal((await f.run(['--profile','','auth','status'])).data.error.code,'invalid_profile');
  await f.connect();await f.run(['project','use',f.project]);
  assert.equal((await f.run(['run','https://shop.example','--key','','--provider','meta','--model','muse-spark-1.3-contributor'])).data.error.code,'invalid_id');
  assert.equal((await f.run(['run','https://shop.example','--project',''])).data.error.code,'invalid_id');
  assert.equal((await f.run(['run','https://shop.example','--model',''])).data.error.code,'invalid_model');
  assert.equal(f.state.accepted.size,0);
});


test('loss of the one-use token response gives a fresh-approval recovery command',async t=>{
  const f=await fixture(t);await f.run(['auth','login','--server',f.origin,'--scopes','runs:read']);f.state.approved=true;f.state.dropExchange=true;
  assert.equal((await f.run(['auth','complete'])).code,5);
  const retry=await f.run(['auth','complete']);assert.equal(retry.code,3);assert.equal(retry.data.error.code,'connection_already_consumed');assert.match(retry.data.error.next_command,/auth login/);assert.match(retry.data.error.next_command,/--scopes runs:read$/);
});

test('issue handoff and verification commands preserve IDs and frozen candidate arguments',async t=>{
  const f=await fixture(t);await f.connect();const issue=randomUUID(),verification=randomUUID();
  const shown=await f.run(['issue','show',issue,'--offset','5','--limit','5','--revision','3']);assert.equal(shown.code,0,shown.stdout);
  assert.deepEqual(f.state.posts.at(-1).body,{issue_id:issue,offset:5,limit:5,expected_revision:3});
  const first=await f.run(['issue','verify',issue,'https://preview.example/editor','--verification-id',verification,'--deployment-ref','commit abc','--project',f.project]);assert.equal(first.code,0,first.stdout);assert.equal(first.data.verification_id,verification);
  const input=f.state.posts.at(-1).body;assert.deepEqual(input,{issue_id:issue,verification_id:verification,candidate_url:'https://preview.example/editor',deployment_ref:'commit abc',project_id:f.project});
  const retry=await f.run(['retry',verification]);assert.equal(retry.code,0);assert.deepEqual(f.state.posts.at(-1).body,input);
  assert.equal((await f.run(['verification','show',verification])).code,0);assert.deepEqual(f.state.posts.at(-1).body,{verification_id:verification});
  assert.equal((await f.run(['issue','show',issue,'--limit','11'])).data.error.code,'invalid_pagination');
  assert.equal((await f.run(['issue','verify',issue,'https://user:password@preview.example'])).data.error.code,'invalid_url');
});
