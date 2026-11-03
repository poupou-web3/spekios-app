// Isolated native CLI integration, against a real API and browser approval UI.
// Synthetic local identities only; no external login, worker or model calls.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(new URL('../packages/browser-runtime/package.json',import.meta.url));
const {Pool}=require('pg'),{chromium}=require('playwright');
assert.equal(process.env.SPEKIOS_CLI_E2E,'1');assert.equal(process.env.PGHOST,'127.0.0.1');assert.equal(process.env.PGDATABASE,'agent_cli_e2e');
const root=resolve(new URL('..',import.meta.url).pathname),temporary=await mkdtemp(join(tmpdir(),'spekios-cli-real-'));
const pool=new Pool({host:process.env.PGHOST,port:Number(process.env.PGPORT),user:process.env.PGUSER,database:process.env.PGDATABASE,password:process.env.POSTGRES_PASSWORD});
const operator=randomBytes(32).toString('hex'),issuer='https://cli-identity.example.test/auth/v1';
const actors=[0,1].map(()=>({user:randomUUID(),workspace:randomUUID(),subject:randomUUID(),cookie:randomBytes(32).toString('base64url')}));
const portServer=createServer();await new Promise(r=>portServer.listen(0,'127.0.0.1',r));const port=portServer.address().port;await new Promise(r=>portServer.close(r));
const origin=`http://localhost:${port}`,entry=join(temporary,'install','bin','spekios'),cwd=join(temporary,'project'),config=join(temporary,'config');await mkdir(cwd);
let api,browser;const errors=[];let apiLog='';
async function run(args){
  const env={...process.env,SPEKIOS_CONFIG_DIR:config};delete env.SPEKIOS_TOKEN;delete env.SPEKIOS_SERVER;
  const child=spawn(entry,args,{cwd,env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
  child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);
  const code=await new Promise((r,j)=>{child.on('error',j);child.on('exit',r);});
  assert.ok(!stdout.includes('scout_agent_')&&!stderr.includes('scout_agent_'),'CLI output leaked an agent credential');
  return {code,data:JSON.parse(stdout),stdout};
}
async function apiJson(path,token,body){
  const r=await fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error'});return {status:r.status,data:await r.json()};
}
try{
  for(const a of actors){
    await pool.query("INSERT INTO workspaces(workspace_id,owner_user_id,name) VALUES($1,$2,'Disposable CLI account')",[a.workspace,a.user]);
    await pool.query('INSERT INTO web_identities(issuer,subject,user_id,workspace_id) VALUES($1,$2,$3,$4)',[issuer,a.subject,a.user,a.workspace]);
    await pool.query('INSERT INTO web_sessions(token_sha256,user_id,workspace_id) VALUES($1,$2,$3)',[createHash('sha256').update(a.cookie).digest('hex'),a.user,a.workspace]);
  }
  api=spawn(join(root,'apps/api/target/debug/scout-api'),[],{cwd:root,stdio:['ignore','ignore','pipe'],env:{...process.env,
    SCOUT_API_BIND:`127.0.0.1:${port}`,SCOUT_API_TOKEN:operator,SCOUT_DEV_AUTH_BYPASS:'false',SCOUT_PUBLIC_ORIGIN:'',
    SPEKIOS_AUTH_ORIGIN:'https://cli-login.example.test',SPEKIOS_ISSUER:issuer,SPEKIOS_CLIENT_ID:'cli-test',SPEKIOS_CLIENT_SECRET:'disposable-cli-client-credential',SPEKIOS_REDIRECT_URI:origin+'/auth/callback',
    SCOUT_PROVIDER_VAULT_KEY:randomBytes(32).toString('hex'),SCOUT_MODEL_TEST_MODE:'',SCOUT_MODEL_FIXTURE_URL:'',OPENAI_API_KEY:'',ANTHROPIC_API_KEY:'',OPENROUTER_API_KEY:'',META_API_KEY:'',MODEL_API_KEY:'',
    S3_ENDPOINT:'http://127.0.0.1:19999',S3_ACCESS_KEY_ID:'disposable-cli-storage-id',S3_SECRET_ACCESS_KEY:'disposable-cli-storage-secret',CLICKHOUSE_PASSWORD:'disposable-cli-clickhouse',CLICKHOUSE_URL:'http://127.0.0.1:19998',MODEL_SPOOL:join(temporary,'spool')}});
  api.stderr.on('data',c=>apiLog=(apiLog+c).slice(-8000));
  for(let i=0;i<100;i++){
    if(api.exitCode!==null)throw Error('Local API exited: '+apiLog);
    if(await fetch(origin+'/readyz',{headers:{Authorization:`Bearer ${operator}`}}).then(r=>r.ok).catch(()=>false))break;await delay(100);
  }
  const download=await fetch(origin+'/assets/cli/spekios-cli.tgz');assert.equal(download.status,200);assert.equal(download.headers.get('content-type'),'application/gzip');
  const archive=join(temporary,'spekios-cli.tgz');await writeFile(archive,Buffer.from(await download.arrayBuffer()));
  async function execute(program,args){
    const child=spawn(program,args,{cwd:temporary,stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>err+=c);
    const code=await new Promise((r,j)=>{child.on('error',j);child.on('exit',r);});assert.equal(code,0,err);return out;
  }
  const files=(await execute('tar',['-tzf',archive])).trim().split('\n').filter(p=>!p.endsWith('/')).sort();
  assert.deepEqual(files,['package/README.md','package/package.json','package/spekios.mjs']);
  const metadata=JSON.parse(await execute('tar',['-xOf',archive,'package/package.json']));assert.equal(metadata.bin.spekios,'spekios.mjs');
  await execute('npm',['install','--global','--prefix',join(temporary,'install'),'--cache',join(temporary,'npm-cache'),'--ignore-scripts','--no-audit','--no-fund',origin+'/assets/cli/spekios-cli.tgz']);
  assert.equal(await readFile(entry,'utf8'),await readFile(join(root,'packages/cli/spekios.mjs'),'utf8'));
  const version=await run(['--version']);assert.equal(version.code,0);assert.equal(version.data.version,metadata.version);
  browser=await chromium.launch({headless:true,...(!existsSync(chromium.executablePath())?{channel:'chrome'}:{})});
  async function approve(profile,actor,{scopes,name}={}){
    const args=['--server',origin,'--profile',profile,'auth','login','--name',name||`CLI ${profile}`];if(scopes)args.push('--scopes',scopes);
    const login=await run(args);assert.equal(login.code,3,login.stdout);
    const pending=await run(['--profile',profile,'auth','complete']);assert.equal(pending.data.status,'authorization_pending');
    const context=await browser.newContext();await context.addCookies([{name:'spekios_session',value:actor.cookie,domain:'localhost',path:'/',httpOnly:true,sameSite:'Lax'}]);
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(login.data.verification_url);
    await page.getByRole('button',{name:'Allow connection',exact:true}).waitFor();
    assert.match(await page.locator('#agent-name').innerText(),new RegExp(name||`CLI ${profile}`));
    await page.getByRole('button',{name:'Allow connection',exact:true}).click();
    await page.getByText('Allowed. Your connector will finish connecting.',{exact:false}).waitFor();
    await context.close();
    // The server throttles token polls at five seconds, including approval.
    await delay(5100);const connected=await run(['--profile',profile,'auth','complete']);assert.equal(connected.code,0,connected.stdout);assert.equal(connected.data.workspace_id,actor.workspace);
    return JSON.parse(await readFile(join(config,profile,'credential.json'),'utf8'));
  }
  const first=await approve('default',actors[0]);
  // The owner configures a fake personal model key; the agent sees its reference
  // only. No worker starts, so this credential is never sent to a provider.
  const keyId=randomUUID();
  const keyResponse=await fetch(origin+'/v1/provider-keys',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,Cookie:'spekios_session='+actors[0].cookie},body:JSON.stringify({key_id:keyId,provider:'meta',name:'Disposable CLI test key',api_key:'disposable-cli-meta-key-'+randomBytes(16).toString('hex'),make_default:true})});
  assert.equal(keyResponse.status,201,await keyResponse.text());
  const project=await run(['project','init']);assert.equal(project.code,0,project.stdout);const projectId=project.data.project_id;
  const contextBytes=await readFile(join(cwd,'.spekios.json'),'utf8');assert.ok(!contextBytes.includes(first.access_token));
  const started=await run(['run','https://example.com','--provider','meta','--model','muse-spark-1.3-contributor','--key',keyId]);assert.equal(started.code,0,started.stdout);const jobId=started.data.data.job?.job_id||started.data.data.job_id||started.data.request_id;
  const stored=(await pool.query('SELECT workspace_id,agent_id,project_id,status FROM browser_jobs WHERE job_id=$1',[jobId])).rows[0];
  assert.equal(stored.workspace_id,actors[0].workspace);assert.equal(stored.agent_id,first.agent_id);assert.equal(stored.project_id,projectId);assert.equal(stored.status,'queued');
  const retry=await run(['retry',started.data.request_id]);assert.equal(retry.code,0,retry.stdout);
  assert.equal(Number((await pool.query('SELECT count(*) FROM browser_jobs')).rows[0].count),1);
  assert.equal((await run(['status',jobId])).code,0);
  assert.equal((await run(['tools','list'])).data.data.interface_version,1);
  assert.equal((await apiJson('/v1/admin/demo',first.access_token)).status,403);
  const cancelled=await run(['tools','call','scout_cancel_work','--input',JSON.stringify({kind:'job',id:jobId})]);assert.equal(cancelled.code,0,cancelled.stdout);
  assert.equal((await pool.query('SELECT status FROM browser_jobs WHERE job_id=$1',[jobId])).rows[0].status,'cancelled');
  const second=await approve('second',actors[1]);
  assert.equal((await run(['--profile','second','run','https://example.com'])).data.error.code,'project_account_mismatch');
  const foreign=await run(['--profile','second','status',jobId]);assert.notEqual(foreign.code,0);assert.ok(foreign.data.error);
  assert.notEqual((await apiJson('/v1/browser-jobs/'+jobId,second.access_token)).status,200);
  await approve('reader',actors[0],{scopes:'runs:read'});
  assert.equal((await run(['--profile','reader','project','list'])).code,0);
  const denied=await run(['--profile','reader','run','https://example.com']);assert.equal(denied.code,4,denied.stdout);
  assert.equal((await run(['auth','logout'])).code,0);
  assert.equal((await apiJson('/v1/identity',first.access_token)).status,401);
  assert.equal(Number((await pool.query('SELECT count(*) FROM runtime_runs')).rows[0].count),0);
  assert.equal(Number((await pool.query('SELECT count(*) FROM model_calls')).rows[0].count),0);
  assert.deepEqual(errors,[]);
  const report={passed:true,checks:['hosted npm package contains only public files','globally installed spekios command','real browser account approval','PKCE exchange and private credentials','project context and agent attribution','idempotent retry','cross-account isolation','read-only permissions','self-revocation'],queued_jobs:1,executed_runs:0,model_calls:0};
  await mkdir(join(root,'artifacts/agent-cli'),{recursive:true});await writeFile(join(root,'artifacts/agent-cli/verification.json'),JSON.stringify(report,null,2)+'\n');
  console.log('Installed spekios command real API/browser verification passed: one queued/cancelled job, zero executed runs or model calls.');
}finally{
  await browser?.close();if(api&&api.exitCode===null){const closed=new Promise(r=>api.once('exit',r));api.kill('SIGTERM');await closed;}
  await pool.end();await rm(temporary,{recursive:true,force:true});
}
