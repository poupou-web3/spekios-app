// Development browser test against a newly created local database. Fake keys
// are used only for storage/selection; a queued job is cancelled without a worker.
// No inference or browser exploration is executed.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer,request as httpRequest} from 'node:http';
import {spawn} from 'node:child_process';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {readFile,mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,extname} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(new URL('../packages/browser-runtime/package.json',import.meta.url));
const {Pool}=require('pg'),{chromium}=require('playwright');
assert.equal(process.env.SPEKIOS_PROVIDER_E2E,'1');
assert.equal(process.env.PGHOST,'127.0.0.1');assert.equal(process.env.PGDATABASE,'provider_access_e2e');
const root=resolve(new URL('..',import.meta.url).pathname),temporary=await mkdtemp(join(tmpdir(),'spekios-provider-access-'));
const pool=new Pool({host:process.env.PGHOST,port:Number(process.env.PGPORT),user:process.env.PGUSER,database:process.env.PGDATABASE,password:process.env.POSTGRES_PASSWORD});
const operator=randomBytes(32).toString('hex'),issuer='https://identity.example.test/auth/v1';
const actors=[0,1].map(()=>({user:randomUUID(),workspace:randomUUID(),subject:randomUUID(),cookie:randomBytes(32).toString('base64url')}));
const secretA='test-only-personal-primary-'+randomBytes(16).toString('hex'),secretB='test-only-personal-backup-'+randomBytes(16).toString('hex'),shared='test-only-shared-demo-'+randomBytes(16).toString('hex');
let apiProcess,browser,backoffice;const errors=[];
async function port(){const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const number=server.address().port;await new Promise(r=>server.close(r));return number;}
const apiPort=await port(),apiOrigin=`http://localhost:${apiPort}`;
try{
  for(const a of actors){
    await pool.query("INSERT INTO workspaces(workspace_id,owner_user_id,name) VALUES($1,$2,'Disposable key test')",[a.workspace,a.user]);
    await pool.query('INSERT INTO web_identities(issuer,subject,user_id,workspace_id) VALUES($1,$2,$3,$4)',[issuer,a.subject,a.user,a.workspace]);
    await pool.query('INSERT INTO web_sessions(token_sha256,user_id,workspace_id) VALUES($1,$2,$3)',[createHash('sha256').update(a.cookie).digest('hex'),a.user,a.workspace]);
  }
  apiProcess=spawn(resolve(root,'apps/api/target/debug/scout-api'),[],{cwd:root,stdio:['ignore','ignore','pipe'],env:{...process.env,
    SCOUT_API_BIND:`127.0.0.1:${apiPort}`,SCOUT_API_TOKEN:operator,SCOUT_DEV_AUTH_BYPASS:'false',SCOUT_PUBLIC_ORIGIN:'',
    SPEKIOS_AUTH_ORIGIN:'https://login.example.test',SPEKIOS_ISSUER:issuer,SPEKIOS_CLIENT_ID:'test-provider-access',SPEKIOS_CLIENT_SECRET:'test-client-credential-never-for-a-real-provider',SPEKIOS_REDIRECT_URI:apiOrigin+'/auth/callback',
    SCOUT_PROVIDER_VAULT_KEY:randomBytes(32).toString('hex'),SCOUT_MODEL_TEST_MODE:'',OPENAI_API_KEY:'',ANTHROPIC_API_KEY:'',OPENROUTER_API_KEY:'',META_API_KEY:'',MODEL_API_KEY:'',
    S3_ENDPOINT:'http://127.0.0.1:19999',S3_ACCESS_KEY_ID:'disposable-storage-access-id',S3_SECRET_ACCESS_KEY:'disposable-storage-access-secret',CLICKHOUSE_PASSWORD:'disposable-clickhouse-password',CLICKHOUSE_URL:'http://127.0.0.1:19998',MODEL_SPOOL:join(temporary,'spool')}});
  let apiLog='';apiProcess.stderr.on('data',b=>{apiLog=(apiLog+b).slice(-12000);});
  for(let i=0;i<100;i++){
    if(apiProcess.exitCode!==null)throw new Error('Test API exited: '+apiLog);
    if(await fetch(apiOrigin+'/healthz').then(r=>r.ok).catch(()=>false))break;
    await delay(100);
  }
  backoffice=createServer(async(req,res)=>{
    const path=new URL(req.url,'http://localhost').pathname;
    if(path.startsWith('/v1/')||path==='/readyz'){
      const upstream=httpRequest(apiOrigin+req.url,{method:req.method,headers:req.headers},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});upstream.on('error',()=>{res.writeHead(502);res.end();});req.pipe(upstream);return;
    }
    const base=path.startsWith('/assets/app/')?'apps/backoffice/src/':path.startsWith('/assets/ui/')?'packages/web-ui/src/':null;
    const file=path==='/'?join(root,'apps/backoffice/index.html'):base?resolve(root,base,path.replace(/^\/assets\/(app|ui)\//,'')):null;
    if(!file||(base?!file.startsWith(resolve(root,base)+'/'):file!==join(root,'apps/backoffice/index.html'))){res.writeHead(404);res.end();return;}
    try{const data=await readFile(file);res.setHeader('content-type',extname(file)==='.js'?'text/javascript':extname(file)==='.css'?'text/css':'text/html');res.end(data);}catch{res.writeHead(404);res.end();}
  });
  await new Promise(r=>backoffice.listen(0,'127.0.0.1',r));const boOrigin=`http://localhost:${backoffice.address().port}`;
  browser=await chromium.launch({headless:true,...(!existsSync(chromium.executablePath())?{channel:'chrome'}:{})});
  const opContext=await browser.newContext(),op=await opContext.newPage();op.on('pageerror',e=>errors.push(e.message));
  await op.goto(boOrigin+'/#/credits');await op.locator('#token').fill(operator);await op.locator('#login-form button[type=submit]').click();
  await op.locator('#demo-allowance').waitFor();await op.locator('#demo-api-key').fill(shared);await op.locator('#demo-enabled').check();await op.locator('#demo-settings-form button[type=submit]').click();
  await op.getByText('Demo settings saved.',{exact:false}).waitFor();assert.equal(await op.locator('#demo-api-key').inputValue(),'');
  const context=await browser.newContext();await context.addCookies([{name:'spekios_session',value:actors[0].cookie,domain:'localhost',path:'/',httpOnly:true,sameSite:'Lax'}]);
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(apiOrigin+'/#/settings/models');await page.locator('#personal-keys-title').waitFor();
  const json=async(path,body)=>page.evaluate(async({path,body})=>{const r=await fetch(path,{method:body===undefined?'GET':'POST',...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});return {status:r.status,body:await r.json()};},{path,body});
  for(let i=0;i<50;i++){if((await json('/v1/model-providers')).body.gateway_ready)break;await delay(100);}
  assert.match(await page.locator('.demo-credits').innerText(),/\$1\.00 demo credits remaining/);
  async function addKey(name,secret){
    await page.getByRole('button',{name:'Add API key',exact:true}).click();await page.locator('#key-provider').selectOption('openai');await page.locator('#key-name').fill(name);await page.locator('#key-secret').fill(secret);await page.locator('#provider-key-form button[type=submit]').click();await page.locator('#provider-key-dialog').waitFor({state:'detached'});await page.getByText(name,{exact:true}).waitFor();
  }
  await addKey('Primary OpenAI',secretA);await addKey('Backup OpenAI',secretB);
  let status=(await json('/v1/model-providers')).body;assert.equal(status.keys.length,2);assert(!JSON.stringify(status).includes(secretA));assert(!JSON.stringify(status).includes('encrypted_key'));
  const primary=status.keys.find(k=>k.name==='Primary OpenAI').key_id,backup=status.keys.find(k=>k.name==='Backup OpenAI').key_id;
  await page.locator('#new-model-provider').selectOption('openai');await page.locator('#new-model-model').fill('gpt-6.1-sol');await page.getByRole('button',{name:'Add model',exact:true}).click();
  await page.locator('#configuration-exploration_model').selectOption('openai|gpt-6.1-sol');await page.locator('#configuration-provider-key').selectOption(backup);await page.getByRole('button',{name:'Save defaults',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.settings-savebar')?.textContent.includes('revision 1'));
  let preferences=(await json('/v1/exploration-settings')).body;assert.equal(preferences.settings.providerKeyId,backup);
  await page.getByRole('button',{name:'Add project model',exact:true}).click();const project=await page.locator('#project-0-project_id').inputValue();assert.match(project,/^[0-9a-f-]{36}$/);await page.locator('#project-0-label').fill('Shop');await page.locator('#project-0-choice').selectOption('openai|gpt-6.1-sol');await page.locator('#project-0-provider-key').selectOption(primary);await page.getByRole('button',{name:'Save defaults',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.settings-savebar')?.textContent.includes('revision 2'));
  preferences=(await json('/v1/exploration-settings')).body;assert.equal(preferences.settings.providerKeyId,backup);assert.equal(preferences.settings.projectModels[0].providerKeyId,primary);assert(!JSON.stringify(preferences).includes(secretA));
  // Model-first setup offers a key immediately, with a name field, without
  // losing the new model or the secret field to a workspace polling refresh.
  await page.locator('#new-model-provider').selectOption('anthropic');await page.locator('#new-model-model').fill('claude-sonnet-5-5');await page.getByRole('button',{name:'Add model',exact:true}).click();await page.locator('#provider-key-dialog').waitFor();
  assert.equal(await page.locator('#key-provider').inputValue(),'anthropic');await page.locator('#key-name').fill('New model connection');await page.locator('#key-secret').fill('disposable-secret-for-refresh-check');
  await page.waitForResponse(r=>r.url().endsWith('/v1/model-providers')&&r.request().method()==='GET',{timeout:15000});assert.equal(await page.locator('#key-secret').inputValue(),'disposable-secret-for-refresh-check');
  await page.getByRole('button',{name:'Cancel',exact:true}).click();assert(await page.locator('#configuration-exploration_model option[value="anthropic|claude-sonnet-5-5"]').count());
  const second=await browser.newContext();await second.addCookies([{name:'spekios_session',value:actors[1].cookie,domain:'localhost',path:'/',httpOnly:true,sameSite:'Lax'}]);const other=await second.newPage();await other.goto(apiOrigin);
  const otherJson=async(path,body)=>other.evaluate(async({path,body})=>{const r=await fetch(path,{method:body===undefined?'GET':'POST',...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});return {status:r.status,body:await r.json()};},{path,body});
  assert.equal((await otherJson('/v1/model-providers')).body.keys.length,0);
  assert.equal((await otherJson('/v1/admin/demo',{})).status,403);
  assert.equal((await otherJson(`/v1/provider-keys/${backup}/revoke`,{})).status,404);
  const cross=await otherJson('/v1/browser-jobs',{job_id:randomUUID(),kind:'explore',target_url:'https://example.com',model:{provider:'openai',model:'gpt-6.1-sol',free_only:false,provider_key_id:primary}});assert.equal(cross.body.error,'provider_key_unavailable');
  const wrongDemo=await otherJson('/v1/browser-jobs',{job_id:randomUUID(),kind:'explore',target_url:'https://example.com',model:{provider:'meta',model:'muse-wonder-1.0',free_only:false,provider_key_id:'demo'}});assert.equal(wrongDemo.body.error,'demo_model_only');
  assert.equal(Number((await pool.query('SELECT count(*) FROM browser_jobs')).rows[0].count),0,'No real job or inference is started by this test.');
  // Seed spent credit only in this disposable database to exercise exhausted UI.
  const call=randomUUID(),request=randomUUID(),demoKey=(await pool.query('SELECT key_id FROM demo_settings')).rows[0].key_id;
  await pool.query("INSERT INTO model_requests(request_id,workspace_id,user_id,provider,model,spec,spec_sha256,state,funding_source,provider_key_id) VALUES($1,$2,$3,'meta','muse-spark-1.3-contributor','{}','test','completed','demo',$4)",[request,actors[0].workspace,actors[0].user,demoKey]);
  await pool.query("INSERT INTO model_calls(call_id,request_id,attempt,state) VALUES($1,$2,1,'completed')",[call,request]);await pool.query('INSERT INTO demo_accounts(user_id) VALUES($1)',[actors[0].user]);await pool.query("INSERT INTO demo_reservations(call_id,user_id,reserved_microusd,charged_microusd,state) VALUES($1,$2,1000000,1000000,'settled')",[call,actors[0].user]);
  await page.reload();await page.getByText('Demo balance too low for the next call',{exact:true}).waitFor();assert.equal(await page.locator('.personal-key-list li').count(),2);assert.equal(await page.locator('#configuration-provider-key').inputValue(),backup);assert.equal((await json('/v1/model-providers')).body.providers.find(p=>p.provider==='openai').configured,true);
  const exhausted=await json('/v1/browser-jobs',{job_id:randomUUID(),kind:'explore',target_url:'https://example.com',model:{provider:'meta',model:'muse-spark-1.3-contributor',free_only:false,provider_key_id:'demo'}});assert.equal(exhausted.status,402);assert.equal(exhausted.body.error,'demo_credits_insufficient');
  const ownJobId=randomUUID(),own=await json('/v1/browser-jobs',{job_id:ownJobId,kind:'explore',target_url:'https://example.com',project_id:project});assert.equal(own.status,202);assert.equal(own.body.job.settings.providerKeyId,primary,'The project key overrides the account key and works after demo exhaustion.');
  assert.equal((await json(`/v1/browser-jobs/${ownJobId}/cancel`,{})).status,200);
  assert.equal(Number((await pool.query('SELECT count(*) FROM runtime_runs')).rows[0].count),0,'No browser exploration is executed.');
  await op.locator('#demo-allowance').fill('2');await op.locator('#demo-settings-form button[type=submit]').click();await op.getByText('Demo settings saved.',{exact:false}).waitFor();
  status=(await json('/v1/model-providers')).body;assert.equal(status.demo.allowance_usd,2);assert.equal(status.demo.spent_usd,1);assert.equal(status.demo.remaining_usd,1);
  await page.reload();await page.locator('#personal-keys-title').waitFor();await page.locator(`[data-action="default-provider-key"][data-id="${backup}"]`).click();
  await page.waitForFunction(id=>document.querySelector(`[data-action="default-provider-key"][data-id="${id}"]`)===null,backup);
  await page.locator(`[data-action="revoke-provider-key"][data-id="${primary}"]`).click();await page.locator('.personal-key-list').getByText('Primary OpenAI',{exact:true}).waitFor({state:'detached'});
  const persisted=await pool.query('SELECT encrypted_key FROM provider_keys');for(const row of persisted.rows){assert(!row.encrypted_key.includes(Buffer.from(secretA)));assert(!row.encrypted_key.includes(Buffer.from(secretB)));assert(!row.encrypted_key.includes(Buffer.from(shared)));}
  const browserStorage=await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}));assert(!browserStorage.includes(secretA));assert(!browserStorage.includes(secretB));assert(!browserStorage.includes(shared));assert.deepEqual(errors,[]);
  await mkdir(join(root,'artifacts/provider-access'),{recursive:true});await page.screenshot({path:join(root,'artifacts/provider-access/personal-keys.png'),fullPage:true});await op.screenshot({path:join(root,'artifacts/provider-access/demo-settings.png'),fullPage:true});
  await writeFile(join(root,'artifacts/provider-access/verification.json'),JSON.stringify({passed:true,checks:['named keys for one provider','encrypted storage and write-only responses','account isolation and admin-only demo config','independent account/project key references','project key bound into admitted job','model-first key dialog survives refresh','demo exhaustion blocks sponsored work but permits personal work','allowance changes preserve spent credit','key defaults and revocation','no secrets in browser storage'],provider_calls:0,queued_and_cancelled_test_jobs:1,executed_browser_runs:0},null,2)+'\n');
  console.log('Provider access browser verification passed; 0 provider calls, 0 executed browser runs; 1 queued test job cancelled.');
}finally{
  await browser?.close();if(backoffice)await new Promise(r=>backoffice.close(r));
  if(apiProcess&&apiProcess.exitCode===null){apiProcess.kill('SIGTERM');await new Promise(r=>apiProcess.once('exit',r));}
  await pool.end();await rm(temporary,{recursive:true,force:true});
}
