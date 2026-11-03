// Disposable integration. Original UI evidence is captured in Chromium; history
// and candidate outcomes are fixture records, not live-model judgments.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(new URL('../packages/browser-runtime/package.json',import.meta.url));
const {Pool}=require('pg'),{chromium}=require('playwright');
assert.equal(process.env.SPEKIOS_HANDOFF_E2E,'1');assert.equal(process.env.PGHOST,'127.0.0.1');assert.equal(process.env.PGDATABASE,'finding_handoff_e2e');
const root=resolve(new URL('..',import.meta.url).pathname),temp=await mkdtemp(join(tmpdir(),'finding-handoff-'));
const pool=new Pool({host:process.env.PGHOST,port:Number(process.env.PGPORT),user:process.env.PGUSER,database:process.env.PGDATABASE,password:process.env.POSTGRES_PASSWORD});
const hash=b=>createHash('sha256').update(b).digest('hex'),operator=randomBytes(32).toString('hex');
const actors=[0,1].map(()=>({workspace:randomUUID(),user:randomUUID(),subject:randomUUID(),cookie:randomBytes(32).toString('base64url'),agent:randomUUID(),token:'scout_agent_'+randomBytes(32).toString('hex')}));
const project=randomUUID(),issuer='https://handoff-identity.example.test/auth/v1';let api,browser,png;
const fixture=createServer((req,res)=>{if(req.url.startsWith('/editor')){res.setHeader('content-type','text/html');res.end('<!doctype html><title>Draft editor</title><h1>Draft editor</h1><p id="state">Ready</p><button>Save draft</button>');}else{res.setHeader('content-type','image/png');res.end(png);}});
await new Promise(r=>fixture.listen(0,'127.0.0.1',r));const fixtureOrigin=`http://127.0.0.1:${fixture.address().port}`,target=fixtureOrigin+'/editor';
const portServer=createServer();await new Promise(r=>portServer.listen(0,'127.0.0.1',r));const port=portServer.address().port;await new Promise(r=>portServer.close(r));const origin=`http://localhost:${port}`;
const control={control_id:'save-1',role:'button',name:'Save draft',enabled:true,visible:true,href:null,rect:{x:20,y:70,width:120,height:30}};
async function seed({actor=actors[0],prefix=false,expected='Saved is visible',observed='Ready remains',goal='Save draft',projectId=project,mode='live',width=1440,auth=null}={}){
  const run=randomUUID(),action=randomUUID(),before=randomUUID(),after=randomUUID();
  const config={runtime_version:'explorer-v1',execution_mode:mode,project_id:projectId,viewport_profile:'desktop',viewport:{width,height:900},browser:'chromium',replay_of:null,auth_contexts:auth?[{context_id:auth,session_id:auth}]:[],training_status:'excluded_fixture'};
  await pool.query("INSERT INTO runtime_runs(run_id,workspace_id,user_id,target_url,lifecycle,config,finished_at) VALUES($1,$2,$3,$4,'completed',$5,now())",[run,actor.workspace,actor.user,target,config]);
  if(prefix)await pool.query("INSERT INTO runtime_actions(action_id,run_id,ordinal,prediction_id,spec,state,assessment) VALUES($1,$2,1,$3,$4,'completed',$5)",[randomUUID(),run,randomUUID(),{command:{type:'navigate',url:target},prediction:{source:'model',expected_result:'Editor opens'}},{verdict:'no_issue_observed',observed_result:'Editor visible'}]);
  const spec={command:{type:'click',control:{...control,control_id:randomUUID(),rect:{x:30,y:90,width:120,height:30}}},prediction:{source:'model',goal,expected_result:expected},...(auth?{auth_context_id:auth}:{})};
  await pool.query("INSERT INTO runtime_actions(action_id,run_id,ordinal,prediction_id,spec,state,before_capture_id,after_capture_id) VALUES($1,$2,$3,$4,$5,'prepared',$6,$7)",[action,run,prefix?2:1,randomUUID(),spec,before,after]);
  for(const [phase,id]of [['before',before],['after',after]])await pool.query("INSERT INTO runtime_captures(capture_id,run_id,action_id,phase,status,object_key,sha256,byte_length,observation) VALUES($1,$2,$3,$4,'available',$5,$6,$7,$8)",[id,run,action,phase,`handoff/${id}.png`,hash(png),png.length,{url:target,title:'Draft editor',text:'Ready Save draft',viewport:{width,height:900},controls:[control],device_scale:1,scroll:{x:0,y:0}}]);
  await pool.query("UPDATE runtime_actions SET state='completed',assessment=$2,finished_at=now() WHERE action_id=$1",[action,{verdict:'suspect',expectation_uncertain:false,observed_result:observed,reason:'The status did not change after clicking Save draft.'}]);
  const issue=(await pool.query('SELECT issue_id FROM issue_occurrences WHERE action_id=$1',[action])).rows[0].issue_id;
  return {run,action,issue,before,after};
}
async function get(path,token=actors[0].token,body){const r=await fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,data:await r.json()};}
async function candidate(issue,outcome){
  const id=randomUUID();await pool.query("INSERT INTO browser_jobs(job_id,workspace_id,user_id,request,settings,execution_mode,status) VALUES($1,$2,$3,$4,'{}','live','completed')",[id,actors[0].workspace,actors[0].user,{kind:'verify_fix'}]);
  await pool.query("INSERT INTO issue_verifications(verification_id,issue_id,workspace_id,user_id,job_id,candidate_url,deployment_ref,source_snapshot,status,outcome,result,finished_at) SELECT $1,issue_id,workspace_id,user_id,$3,$4,'fixture release',snapshot,'completed',$5,$6,clock_timestamp() FROM issues WHERE issue_id=$2",[id,issue,id,target,outcome,{outcome,reason:'Seeded candidate outcome for history validation',evidence_verified:true}]);return id;
}
try{
  browser=await chromium.launch({headless:true,...(!existsSync(chromium.executablePath())?{channel:'chrome'}:{})});
  const evidence=await browser.newPage({viewport:{width:1440,height:900}});await evidence.goto(target);await evidence.getByRole('button',{name:'Save draft'}).click();png=await evidence.screenshot();await evidence.close();
  for(const a of actors){
    await pool.query("INSERT INTO workspaces(workspace_id,owner_user_id,name) VALUES($1,$2,'Handoff fixture account')",[a.workspace,a.user]);
    await pool.query('INSERT INTO web_identities(issuer,subject,user_id,workspace_id) VALUES($1,$2,$3,$4)',[issuer,a.subject,a.user,a.workspace]);
    await pool.query('INSERT INTO web_sessions(token_sha256,user_id,workspace_id) VALUES($1,$2,$3)',[hash(a.cookie),a.user,a.workspace]);
    await pool.query("INSERT INTO agent_identities(agent_id,workspace_id,name) VALUES($1,$2,'Handoff fixture agent')",[a.agent,a.workspace]);
    await pool.query("INSERT INTO workspace_credentials(credential_id,workspace_id,agent_id,token_sha256,scopes,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '1 hour')",[randomUUID(),a.workspace,a.agent,hash(a.token),['runs:read','runs:write','usage:read']]);
  }
  // Seed an actual legacy fingerprint, then upgrade without changing its ID.
  await pool.query(await readFile(join(root,'infra/postgres/021-issue-triage.sql'),'utf8'));
  const first=await seed();const original=(await pool.query('SELECT snapshot,fingerprint FROM issues WHERE issue_id=$1',[first.issue])).rows[0];
  const migration=await readFile(join(root,'infra/postgres/029-issue-handoff-history.sql'),'utf8');await pool.query(migration);
  await pool.query("SELECT scout_triage_issue($1,$2,$3,'human',NULL,'bug',NULL,'Save leaves the status at Ready',0)",[first.issue,actors[0].workspace,actors[0].user]);
  const second=await seed({prefix:true,goal:'Try saving the draft',expected:' saved IS visible ',observed:' Ready REMAINS '});assert.equal(second.issue,first.issue);
  const concurrent=await Promise.all([seed({prefix:true}),seed()]);assert.ok(concurrent.every(x=>x.issue===first.issue));
  assert.equal(Number((await pool.query('SELECT count(*) FROM issue_occurrences WHERE issue_id=$1',[first.issue])).rows[0].count),4);
  assert.deepEqual((await pool.query('SELECT snapshot,fingerprint FROM issues WHERE issue_id=$1',[first.issue])).rows[0],original);
  const changed=await seed({observed:'An error banner appears'});assert.notEqual(changed.issue,first.issue);assert.equal((await pool.query('SELECT scout_issue_triage($1) value',[changed.issue])).rows[0].value,null);
  for(const options of [{actor:actors[1]},{projectId:randomUUID()},{mode:'protocol_fixture'},{width:800},{auth:randomUUID()}])assert.notEqual((await seed(options)).issue,first.issue);
  const freshConcurrent=await Promise.all([seed({observed:'A new shared error appears'}),seed({observed:'A new shared error appears'})]);assert.equal(freshConcurrent[0].issue,freshConcurrent[1].issue);assert.notEqual(freshConcurrent[0].issue,first.issue);
  const signedIn=await seed({auth:randomUUID()});assert.notEqual((await seed({auth:randomUUID()})).issue,signedIn.issue);
  const unchangedTracking=(await pool.query('SELECT scout_issue_tracking($1) value',[first.issue])).rows[0].value;
  await pool.query("INSERT INTO runtime_runs(run_id,workspace_id,user_id,target_url,lifecycle,config,finished_at) VALUES($1,$2,$3,$4,'completed',$5,now())",[randomUUID(),actors[0].workspace,actors[0].user,target,{project_id:project,execution_mode:'live'}]);
  assert.deepEqual((await pool.query('SELECT scout_issue_tracking($1) value',[first.issue])).rows[0].value,unchangedTracking);
  await candidate(first.issue,'resolved');assert.equal((await pool.query('SELECT scout_issue_tracking($1) value',[first.issue])).rows[0].value.status,'verified_on_candidate');
  const seenAgain=await seed({prefix:true});assert.equal(seenAgain.issue,first.issue);
  assert.equal((await pool.query('SELECT scout_issue_tracking($1) value',[first.issue])).rows[0].value.status,'observed_again');
  const eventCount=Number((await pool.query('SELECT count(*) FROM issue_events')).rows[0].count);await pool.query(migration);await pool.query(migration);assert.equal(Number((await pool.query('SELECT count(*) FROM issue_events')).rows[0].count),eventCount);
  await assert.rejects(pool.query("UPDATE issues SET snapshot='{}' WHERE issue_id=$1",[first.issue]));await assert.rejects(pool.query('DELETE FROM issue_events WHERE issue_id=$1',[first.issue]));
  await assert.rejects(pool.query('DELETE FROM issue_signatures WHERE issue_id=$1',[first.issue]));
  api=spawn(join(root,'apps/api/target/debug/scout-api'),[],{cwd:root,stdio:['ignore','ignore','pipe'],env:{...process.env,SCOUT_API_BIND:`127.0.0.1:${port}`,SCOUT_API_TOKEN:operator,SCOUT_DEV_AUTH_BYPASS:'false',SCOUT_PUBLIC_ORIGIN:'',SCOUT_ALLOWED_ORIGINS:fixtureOrigin,SPEKIOS_AUTH_ORIGIN:'https://handoff-login.example.test',SPEKIOS_ISSUER:issuer,SPEKIOS_CLIENT_ID:'handoff-test',SPEKIOS_CLIENT_SECRET:'disposable-handoff-client-secret-for-local-testing',SPEKIOS_REDIRECT_URI:origin+'/auth/callback',SCOUT_PROVIDER_VAULT_KEY:randomBytes(32).toString('hex'),SCOUT_MODEL_TEST_MODE:'',OPENAI_API_KEY:'',ANTHROPIC_API_KEY:'',OPENROUTER_API_KEY:'',META_API_KEY:'',MODEL_API_KEY:'',S3_ENDPOINT:fixtureOrigin,S3_ACCESS_KEY_ID:'disposable-handoff-storage-id',S3_SECRET_ACCESS_KEY:'disposable-handoff-storage-secret',CLICKHOUSE_PASSWORD:'disposable-handoff-clickhouse',CLICKHOUSE_URL:'http://127.0.0.1:19998',MODEL_SPOOL:join(temp,'spool')}});
  let apiLog='';api.stderr.on('data',c=>apiLog=(apiLog+c).slice(-6000));for(let i=0;i<100;i++){if(api.exitCode!==null)throw Error(apiLog);if(await fetch(origin+'/healthz').then(r=>r.ok).catch(()=>false))break;await delay(100);}
  const detail=await get(`/v1/issues/${first.issue}`);assert.equal(detail.status,200,JSON.stringify(detail.data));assert.equal(detail.data.issue.tracking.status,'observed_again');assert.equal(detail.data.occurrences.total,5);assert.equal(detail.data.issue.triage_status,'bug');assert.ok(detail.data.related_findings.items.some(x=>x.issue_id===changed.issue));
  const agent=await get('/v1/agent/tools/scout_get_issue',actors[0].token,{issue_id:first.issue});assert.equal(agent.status,200);assert.equal(agent.data.structuredContent.handoff.agent_description.text,detail.data.handoff.agent_description.text);
  assert.equal((await get(`/v1/issues/${first.issue}`,actors[1].token)).status,404);
  assert.equal((await get(`/v1/issues/${first.issue}?offset=1&expected_revision=1`)).status,409);
  const context=await browser.newContext();await context.addCookies([{name:'spekios_session',value:actors[0].cookie,domain:'localhost',path:'/',httpOnly:true,sameSite:'Lax'}]);
  await context.addInitScript(()=>{Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.handoffClipboard=text;}}});});
  const page=await context.newPage(),errors=[];page.setDefaultTimeout(15000);page.on('pageerror',e=>{errors.push(e.message);console.error('Browser error: '+e.message);});await page.goto(origin+'/issues#'+first.issue);
  await page.getByRole('button',{name:'Copy for a coding agent',exact:true}).waitFor().catch(async e=>{console.error('Page state: '+(await page.locator('body').innerText()).slice(0,3000));throw e;});
  await page.getByRole('button',{name:'Copy for a coding agent',exact:true}).click();
  const preview=page.locator('#agent-handoff-preview');await preview.waitFor();const copied=await preview.inputValue();assert.equal(copied,detail.data.handoff.agent_description.text);assert.match(copied,/Save draft/);assert.match(copied,/Saved is visible/);assert.match(copied,/Ready remains/);
  await seed({goal:'A later identical failure'});await delay(5200);assert.equal(await preview.inputValue(),copied);
  await page.getByRole('button',{name:'Copy description',exact:true}).click();assert.equal(await page.evaluate(()=>window.handoffClipboard),copied);
  const output=join(root,'artifacts/finding-handoff');await mkdir(output,{recursive:true});await page.screenshot({path:join(output,'handoff-preview.png')});
  await page.getByRole('button',{name:'Close',exact:true}).click();await page.locator('#issue-occurrences').getByRole('link',{name:'Open this occurrence'}).first().waitFor();
  await page.goto(origin+`/#/workspace/${second.run}/${second.action}`);await page.getByRole('button',{name:'Copy for a coding agent',exact:true}).click();
  const byAction=await get(`/v1/runs/${second.run}/issues/${second.action}`);assert.equal(byAction.status,200);assert.equal(await page.locator('#agent-handoff-preview').inputValue(),byAction.data.agent_description.text);
  // Install and use the same normal command an external coding agent receives.
  async function command(program,args,env={}){
    const child=spawn(program,args,{cwd:temp,env:{...process.env,...env},stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>err+=c);const code=await new Promise((r,j)=>{child.on('error',j);child.on('exit',r);});return {code,out,err};
  }
  const installed=await command('npm',['install','--global','--prefix',join(temp,'install'),'--cache',join(temp,'npm-cache'),'--ignore-scripts','--no-audit','--no-fund',origin+'/assets/cli/spekios-cli.tgz']);assert.equal(installed.code,0,installed.err);
  const config=join(temp,'cli-config');await mkdir(join(config,'default'),{recursive:true,mode:0o700});
  await writeFile(join(config,'default','credential.json'),JSON.stringify({version:1,server:origin,workspace_id:actors[0].workspace,agent_id:actors[0].agent,access_token:actors[0].token,expires_at:Date.now()+3600000}),{mode:0o600});
  async function cli(args){const r=await command(join(temp,'install/bin/spekios'),args,{SPEKIOS_CONFIG_DIR:config,SPEKIOS_TOKEN:'',SPEKIOS_SERVER:''});assert.ok(!r.out.includes(actors[0].token));return {...r,data:JSON.parse(r.out)};}
  const shown=await cli(['issue','show',first.issue]);assert.equal(shown.code,0,shown.out);assert.equal(shown.data.data.handoff.agent_description.text,(await get('/v1/issues/'+first.issue)).data.handoff.agent_description.text);
  const keyId=randomUUID();const keyResponse=await fetch(origin+'/v1/provider-keys',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,Cookie:'spekios_session='+actors[0].cookie},body:JSON.stringify({key_id:keyId,provider:'meta',name:'Disposable handoff key',api_key:'disposable-handoff-meta-key-'+randomBytes(16).toString('hex'),make_default:true})});assert.equal(keyResponse.status,201,await keyResponse.text());
  await pool.query('INSERT INTO exploration_settings_versions(request_id,workspace_id,user_id,revision,expected_revision,settings) VALUES($1,$2,$3,1,0,$4)',[randomUUID(),actors[0].workspace,actors[0].user,{provider:'meta',model:'muse-spark-1.3-contributor',providerKeyId:keyId}]);
  const verify=await cli(['issue','verify',first.issue,target,'--deployment-ref','CLI candidate fixture']);assert.equal(verify.code,0,verify.out);
  const verificationId=verify.data.verification_id;assert.equal((await cli(['retry',verify.data.request_id])).code,0);
  const state=await cli(['verification','show',verificationId]);assert.equal(state.code,0,state.out);assert.equal(state.data.data.verification.verification_id,verificationId);
  assert.equal((await get('/v1/browser-jobs/'+verificationId,actors[0].token,undefined)).data.job.status,'queued');
  assert.equal((await get('/v1/browser-jobs/'+verificationId+'/cancel',actors[0].token,{})).status,200);
  const cancelled=(await cli(['verification','show',verificationId])).data.data.verification;assert.equal(cancelled.outcome,'inconclusive');
  assert.deepEqual(errors,[]);assert.equal(Number((await pool.query('SELECT count(*) FROM model_calls')).rows[0].count),0);
  await writeFile(join(output,'verification.json'),JSON.stringify({passed:true,checks:['legacy identity retained','same failure across changed paths','concurrent occurrences','different failures remain separate','workspace/project/mode/viewport/sign-in separation','review and original evidence preserved','later observation does not inherit resolved status','idempotent migration','API and copy preview equality','preview survives polling','run action copy','account isolation','installed CLI issue handoff and candidate verification','cancelled verification remains inconclusive'],model_calls:0},null,2)+'\n');
  console.log('Finding handoff/history verification passed; zero model calls.');
}finally{await browser?.close();if(api&&api.exitCode===null){const done=new Promise(r=>api.once('exit',r));api.kill('SIGTERM');await done;}await pool.end();await new Promise(r=>fixture.close(r));await rm(temp,{recursive:true,force:true});}
