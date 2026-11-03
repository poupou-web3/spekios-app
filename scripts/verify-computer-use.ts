// Actual gateway, SQL accounting, explorer and browser; model responses and
// storage are local fixtures. This never contacts a model provider.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {Store} from '../packages/browser-runtime/src/store.js';
import {ModelClient} from '../packages/browser-runtime/src/model-client.js';
import {explore,reproduce} from '../packages/browser-runtime/src/explorer.js';
import {chromium} from '../packages/browser-runtime/node_modules/playwright/index.mjs';
assert.equal(process.env.SCOUT_COMPUTER_E2E,'1');assert.equal(process.env.PGHOST,'127.0.0.1');assert.equal(process.env.PGDATABASE,'scout');
const root=resolve(new URL('..',import.meta.url).pathname),temp=await mkdtemp(join(tmpdir(),'spekios-computer-'));
const operator=randomBytes(32).toString('hex'),objects=new Map<string,Buffer>();
const calls:any[]=[];let unsupported=false,unsafe=false;
const server=createServer(async(req,res)=>{
  const chunks:Buffer[]=[];for await(const c of req)chunks.push(Buffer.from(c));const bytes=Buffer.concat(chunks);
  const url=new URL(req.url!,'http://fixture');
  if(url.pathname.startsWith('/qa-evidence/')){
    if(req.method==='PUT'){objects.set(url.pathname,bytes);res.setHeader('ETag','"'+createHash('sha256').update(bytes).digest('hex')+'"');res.end();return;}
    const data=objects.get(url.pathname);if(!data){res.writeHead(404);res.end();return;}
    res.setHeader('content-length',data.length);res.end(req.method==='HEAD'?undefined:data);return;
  }
  if(url.pathname==='/meta'){
    const body=JSON.parse(bytes.toString());calls.push(body);
    const text=body.input[0].content[0].text;let input:any;try{input=JSON.parse(text);}catch{}
    let output:any;
    if(body.tools){
      output=unsupported?[{type:'message',content:[{type:'output_text',text:'I can use computers.'}]}]:[{type:'computer_call',call_id:'cc_'+randomUUID(),pending_safety_checks:unsafe?[{id:'check',code:'malicious_instructions',message:'Fixture safety check'}]:[],actions:[input?{type:'scroll',x:120,y:120,scroll_x:0,scroll_y:320}:{type:'screenshot'}]}];
    }else{
      let answer:any;
      if(input.task==='plan')answer={candidates:[],stop_reason:'No native controls.'};
      else if(input.task==='assessment')answer={verdict:input.action?.type==='computer'?'suspect':'no_issue_observed',reason:'Synthetic assessment for replay-contract validation, not a real bug judgment.',observed_result:'The panel is visible.',evidence_capture_ids:input.response_schema.evidence_capture_ids,expectation_uncertain:false};
      else answer={goal:'View the list',expected_result:input.task==='navigation_prediction'?'The list opens.':'Lower rows become visible.'};
      output=[{type:'message',content:[{type:'output_text',text:JSON.stringify(answer)}]}];
    }
    res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'resp_'+randomUUID(),model:body.model,status:'completed',output,usage:{input_tokens:30,output_tokens:20}}));return;
  }
  if(url.pathname==='/app'){
    res.setHeader('content-type','text/html');res.end('<!doctype html><style>body{margin:0}#panel{position:absolute;left:20px;top:20px;width:300px;height:300px;overflow:auto;border:1px solid}p{height:80px}</style><div id="panel">'+Array.from({length:20},(_,i)=>`<p>List row ${i}</p>`).join('')+'</div>');return;
  }
  res.end(''); // ClickHouse acknowledges the local fixture export.
});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
const address=server.address();assert(address&&typeof address!=='string');const fixture=`http://127.0.0.1:${address.port}`;
const portServer=createServer();await new Promise<void>(r=>portServer.listen(0,'127.0.0.1',r));const port=(portServer.address() as any).port;await new Promise<void>(r=>portServer.close(()=>r()));
const origin=`http://127.0.0.1:${port}`;
Object.assign(process.env,{SCOUT_API_URL:origin,SCOUT_API_TOKEN:operator,SCOUT_BROWSER_ENDPOINT:'',S3_ENDPOINT:fixture,S3_ACCESS_KEY_ID:'disposable-computer-storage',S3_SECRET_ACCESS_KEY:'disposable-computer-secret',CLICKHOUSE_ENDPOINT:fixture,CLICKHOUSE_PASSWORD:'disposable-computer-clickhouse',RECORDER_SPOOL:join(temp,'recorder')});
let api:any,store:Store|undefined,browser:any;let apiLog='';
async function request(path:string,body?:unknown){const r=await fetch(origin+path,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${operator}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const data=await r.json();assert(r.ok,JSON.stringify(data));return data;}
async function settled(id:string){for(let i=0;i<100;i++){const report=await request('/v1/model-requests/'+id);if(['completed','failed','cancelled'].includes(report.request.state))return report;await delay(100);}throw Error('Fixture model call did not settle');}
try{
  api=spawn(join(root,'apps/api/target/debug/scout-api'),[],{cwd:root,stdio:['ignore','ignore','pipe'],env:{...process.env,SCOUT_API_BIND:`127.0.0.1:${port}`,SCOUT_DEV_AUTH_BYPASS:'false',SCOUT_PUBLIC_ORIGIN:'',SPEKIOS_AUTH_ORIGIN:'',SCOUT_MODEL_TEST_MODE:'1',SCOUT_MODEL_FIXTURE_URL:fixture,MODEL_SPOOL:join(temp,'gateway'),CLICKHOUSE_URL:fixture,SCOUT_PROVIDER_VAULT_KEY:randomBytes(32).toString('hex'),OPENAI_API_KEY:'',ANTHROPIC_API_KEY:'',OPENROUTER_API_KEY:'',META_API_KEY:'',MODEL_API_KEY:''}});
  api.stderr.on('data',(c:Buffer)=>apiLog=(apiLog+c).slice(-4000));
  let ready=false;for(let i=0;i<100;i++){if(api.exitCode!==null)throw Error('Fixture API exited: '+apiLog);if(await fetch(origin+'/readyz',{headers:{Authorization:`Bearer ${operator}`}}).then(r=>r.ok).catch(()=>false)){ready=true;break;}await delay(100);}assert(ready);
  const probe=randomUUID();await request('/v1/computer-use/check',{request_id:probe,provider:'meta',model:'muse-spark-1.3-contributor'});
  assert.equal((await settled(probe)).request.state,'completed');
  const providers=await request('/v1/model-providers');assert(providers.computer_use.verified_connections.some((c:any)=>c.model==='muse-spark-1.3-contributor'));
  assert.equal(calls[0].tools[0].type,'computer');assert.equal(calls[0].input[0].content.length,1,'Probe must not include app screenshots');
  unsupported=true;const failed=randomUUID();await request('/v1/computer-use/check',{request_id:failed,provider:'meta',model:'unknown-meta-model'});assert.equal((await settled(failed)).request.state,'failed');unsupported=false;
  store=await new Store().open();
  const run=(enabled:boolean,model='muse-spark-1.3-contributor')=>explore(store!,fixture+'/app',{client:new ModelClient({provider:'meta',model,freeOnly:false,computerUse:enabled}),maxActions:2,authMode:'public',appMemory:false});
  const before=calls.length;const disabled=await run(false);assert.equal(disabled.report.run.lifecycle,'completed',disabled.report.run.error);assert.equal(disabled.report.actions.length,1);assert(!calls.slice(before).some(c=>c.tools));
  const recovered=await run(true);assert.equal(recovered.report.run.lifecycle,'completed',recovered.report.run.error);assert.equal(recovered.report.actions.length,2);const action=recovered.report.actions[1];assert.equal(action.spec.command.type,'computer');assert.equal(action.state,'completed');assert.equal(action.outcome.status,'settled');
  assert.notEqual(recovered.report.captures.find((c:any)=>c.capture_id===action.before_capture_id).sha256,recovered.report.captures.find((c:any)=>c.capture_id===action.after_capture_id).sha256,'Panel scroll must change actual pixels');
  assert.equal(recovered.report.model_usage.complete,true);assert(recovered.report.model_usage.known_input_tokens>0);assert.equal(recovered.report.run.config.computer_recovery.actions,1);
  const nativeBeforeReplay=calls.filter(c=>c.tools).length;
  const replay=await reproduce(store,action.action_id,{client:new ModelClient({provider:'meta',model:'muse-spark-1.3-contributor',freeOnly:false,computerUse:true}),authMode:'public',appMemory:false});
  assert.equal(replay.report.run.lifecycle,'completed',replay.report.run.error);assert.equal(replay.report.actions[1].spec.command.type,'computer');assert.equal(replay.report.actions[1].state,'completed');assert.equal(calls.filter(c=>c.tools).length,nativeBeforeReplay,'Replay executes the frozen gesture without native model replanning');
  unsafe=true;const guarded=await run(true,'muse-spark-1.3');unsafe=false;assert.equal(guarded.report.run.lifecycle,'completed',guarded.report.run.error);assert.equal(guarded.report.actions.length,1);assert(guarded.report.events.some((e:any)=>e.event_type==='computer.recovery_unavailable'));
  const unverified=await run(true,'unverified-model');assert.equal(unverified.report.actions.length,1);assert.equal(unverified.report.run.lifecycle,'completed',unverified.report.run.error);assert(unverified.report.events.some((e:any)=>e.event_type==='computer.recovery_unavailable'));
  const otherWorkspace=randomUUID(),otherUser=randomUUID();await store.query("INSERT INTO workspaces(workspace_id,owner_user_id,name) VALUES($1,$2,'Other fixture account')",[otherWorkspace,otherUser]);
  const isolated=await store.withScope({workspaceId:otherWorkspace,userId:otherUser},()=>run(true));assert.equal(isolated.report.actions.length,1,'Another account cannot use this account’s Contributor verification');assert.equal(isolated.report.run.lifecycle,'completed',isolated.report.run.error);
  // Exercise the actual model settings page, capability check and saved opt-out.
  await request('/v1/exploration-settings',{request_id:randomUUID(),expected_revision:0,provider:'meta',model:'muse-spark-1.3',saved_models:[{provider:'meta',model:'muse-spark-1.3'},{provider:'meta',model:'muse-spark-1.3-contributor'},{provider:'openrouter',model:'meta/muse-spark-1.3'}],viewport_profile:'desktop',free_only:false,auto_reproduce:false,max_auto_reproductions:2,max_auto_replay_actions:12});
  browser=await chromium.launch({headless:true});const page=await browser.newPage();const errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message));
  await page.addInitScript(token=>sessionStorage.setItem('scout.workspace-token',token),operator);await page.goto(origin+'/#/settings/models');
  const rows=page.locator('.model-row');await rows.nth(0).getByLabel('Allow computer-use recovery').waitFor();
  assert.equal(await rows.nth(0).getByLabel('Allow computer-use recovery').isChecked(),true);assert.equal(await rows.nth(1).getByLabel('Allow computer-use recovery').isEnabled(),true);assert.equal(await rows.nth(1).getByLabel('Allow computer-use recovery').isChecked(),false);assert.equal(await rows.nth(2).getByLabel('Allow computer-use recovery').isEnabled(),false);
  await rows.nth(0).getByLabel('Allow computer-use recovery').uncheck();await page.getByRole('button',{name:'Save defaults',exact:true}).click();await page.locator('.settings-savebar-status strong').filter({hasText:'Saved revision 2'}).waitFor();
  assert.equal((await request('/v1/exploration-settings')).settings.savedModels[0].computerUse,false);assert.deepEqual(errors,[]);
  await rows.nth(1).getByRole('button',{name:'Check compatibility',exact:true}).click();await page.getByText('Compatibility confirmed for this connection.',{exact:false}).waitFor();
  await rows.nth(1).getByLabel('Allow computer-use recovery').check();await page.getByRole('button',{name:'Save defaults',exact:true}).click();await page.locator('.settings-savebar-status strong').filter({hasText:'Saved revision 3'}).waitFor();
  assert.equal((await request('/v1/exploration-settings')).settings.savedModels[1].computerUse,true);
  await mkdir(join(root,'artifacts/computer-use'),{recursive:true});await page.screenshot({path:join(root,'artifacts/computer-use/settings.png'),fullPage:true});
  await writeFile(join(root,'artifacts/computer-use/verification.json'),JSON.stringify({checks:['native_probe_has_no_app_screenshots','text_claim_is_not_capability','disabled_has_no_native_calls','real_panel_scroll_has_recorded_evidence_and_usage','recorded_visual_replay_without_native_calls','safety_checks_block_execution','unverified_model_keeps_normal_exploration','capability_proof_cannot_cross_accounts','gui_compatibility_check_and_persistent_permissions'],run_id:recovered.run_id,model_calls:calls.length},null,2)+'\n');
  console.log('Computer-use integration passed: real browser recovery, gateway accounting, capability checks and settings.');
}finally{
  await browser?.close();await store?.close();if(api&&api.exitCode===null){api.kill('SIGTERM');await new Promise(r=>api.once('exit',r));}await new Promise<void>(r=>server.close(()=>r()));await rm(temp,{recursive:true,force:true});
}
