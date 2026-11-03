import {appSource} from './support.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

// Exercise rendered contracts and event/navigation behavior without a browser.
function workspace(options={}){
  const handlers={},documentHandlers={},saved=new Map(),node={innerHTML:'',classList:{add(){},remove(){}},querySelectorAll(){return[];},addEventListener(type,fn){(handlers[type]??=[]).push(fn);}};
  const document={activeElement:null,querySelector(){return node;},getElementById(){return null;},addEventListener(type,fn){(documentHandlers[type]??=[]).push(fn);}};
  const location={hash:'#/workspace'},sandbox={document,location,window:{addEventListener(){}},sessionStorage:{getItem:key=>saved.get(key)||null,setItem:(key,value)=>saved.set(key,value),removeItem:key=>saved.delete(key)},setInterval(){},setTimeout(){return 0;},clearTimeout(){},AbortSignal,URL,crypto:{randomUUID:()=> '00000000-0000-4000-8000-000000000088'},...options};
  vm.createContext(sandbox);
  vm.runInContext(appSource('main.js')+'\nglobalThis.testing={state,home,landingView,workspaceRuns,workspaceSetup,activityView,activityButton,shell,runView,imagePanel,drawer,render,submitJob,followSubmittedJob,route,bootstrapSession,api,refresh,restartRequest,continueRequest,selectWebsite,workspaceWebsites};',sandbox);
  return {...sandbox.testing,node,document,handlers,documentHandlers,location,saved};
}
const run=(id,extra={})=>({run_id:id,target_url:'https://'+id+'.test',lifecycle:'completed',config:{runtime_version:'explorer-v1',replay_of:null,execution_mode:'live',viewport_profile:'desktop'},summary:{actions:3,candidates:1,pending_findings:1,confirmed_findings:0,dismissed_findings:0},...extra});
const payloads=(jobs=[])=>new Proxy({'/v1/runs':{runs:[]},'/v1/browser-jobs':{jobs,workers:[],settings:{}},'/v1/model-providers':{providers:[]},'/v1/browser-access':{requests:[],sessions:[]}},{get:(data,path)=>data[String(path).split('?')[0]]});
const connect=ui=>Object.assign(ui.state,{connected:true,token:'local-test-token'});
const response=value=>({ok:true,status:200,json:async()=>value});

test('website selection scopes history and keeps the overview focused on the selected website',()=>{
  const ui=workspace();ui.state.runs=[run('a',{target_url:'https://a.test/signup'}),run('a2',{target_url:'https://a.test/pricing'}),run('b')];
  ui.selectWebsite('https://a.test',{prefill:true});
  assert.deepEqual(Array.from(ui.workspaceRuns(),r=>r.run_id),['a','a2']);
  assert.match(ui.home(),/A fresh look at/);assert.match(ui.home(),/website-test-card/);assert.doesNotMatch(ui.home(),/b\.test|run-search/);
  assert.match(ui.shell(ui.home()),/Test a new URL/);assert.doesNotMatch(ui.shell(ui.home()),/>Recent tests<\/div>/);
  ui.state.websitePage='tests';assert.match(ui.home(),/id="run-search"/);
});
test('activity collects queued work and private sign-in across websites',()=>{
  const ui=workspace();ui.state.jobs=[{job_id:'a',status:'queued',request:{kind:'explore',target_url:'https://a.test/checkout'}},{job_id:'b',status:'running',request:{kind:'explore',target_url:'https://b.test/private'}}];
  ui.state.access.requests=[{status:'waiting',origin:'https://a.test',access_id:'a-access'},{status:'waiting',origin:'https://b.test',access_id:'b-access'}];
  ui.selectWebsite('https://a.test');const html=ui.activityView();assert.match(html,/a\.test/);assert.match(html,/b\.test/);assert.match(html,/b-access/);assert.doesNotMatch(ui.home(),/b-access|In progress/);assert.match(ui.activityButton(),/2 running, 2 notifications/);
  assert.equal(ui.workspaceWebsites().filter(s=>s.origin==='https://a.test').length,1);
});
test('a scoped URL restores the website and requests its history without dropping the complete website catalog',async()=>{
  const paths=[],catalog=[{origin:'https://old.test',run_count:120,target_url:'https://old.test/editor'},{origin:'https://new.test',run_count:5,target_url:'https://new.test'}];
  const ui=workspace({fetch:async path=>{paths.push(path);return response(path.startsWith('/v1/runs?')?{runs:[run('older',{target_url:'https://old.test/editor'})],websites:catalog,total:120,next_offset:50}:payloads()[path]);}});connect(ui);
  ui.location.hash='#/website/https%3A%2F%2Fold.test/tests';await ui.route();
  assert.equal(ui.state.websiteOrigin,'https://old.test');assert.equal(ui.state.websitePage,'tests');assert.equal(ui.state.url,'https://old.test/');
  assert.ok(paths.includes('/v1/runs?origin=https%3A%2F%2Fold.test&offset=0'));assert.equal(ui.state.runNextOffset,50);
  assert.equal(ui.workspaceWebsites().length,2);assert.match(ui.shell(ui.home()),/120 tests/);assert.match(ui.home(),/data-action="runs-page"/);
});
test('the switcher validates new URLs and launches once through the normal job admission flow',async()=>{
  const posted=[],job={job_id:'00000000-0000-4000-8000-000000000088',status:'queued',request:{kind:'explore',target_url:'https://a.test/pricing'}},data=payloads([job]);
  class SwitcherFormData extends Map{constructor(form){super(form.fields);}}
  const ui=workspace({FormData:SwitcherFormData,fetch:async(path,options)=>{if(options.method==='POST'){posted.push(JSON.parse(options.body));return response({job});}return response(data[path]);}});connect(ui);ready(ui);
  const submit=url=>ui.handlers.submit[0]({preventDefault(){},target:{id:'website-launch-form',fields:[['url',url]]}});
  await submit('javascript:alert(1)');assert.equal(posted.length,0);assert.match(ui.state.websiteLaunchError,/web address/);
  await submit('a.test/pricing');assert.equal(posted.length,1);assert.equal(posted[0].target_url,'https://a.test/pricing');assert.equal(posted[0].auth_mode,'auto');
  assert.equal(ui.state.websiteOrigin,'https://a.test');assert.equal(ui.state.trackedJobId,job.job_id);assert.equal(ui.saved.get('scout.pending-job'),undefined);
  assert.equal(ui.workspaceWebsites().filter(s=>s.origin==='https://a.test').length,1);
});
test('switching websites during a refresh rejects the old page and immediately fetches the new selection',async()=>{
  let release,entered;const firstStarted=new Promise(resolve=>entered=resolve),oldPage=new Promise(resolve=>release=resolve),paths=[];
  const ui=workspace({fetch:async path=>{
    paths.push(path);
    if(path.startsWith('/v1/runs?origin=https%3A%2F%2Fa.test')){entered();return oldPage;}
    return response(path.startsWith('/v1/runs?')?{runs:[run('b')],websites:[{origin:'https://b.test',target_url:'https://b.test'}],total:1}:payloads()[path]);
  }});connect(ui);ui.selectWebsite('https://a.test');const pending=ui.refresh();await firstStarted;
  ui.selectWebsite('https://b.test',{prefill:true});await ui.refresh();release(response({runs:[run('a')],websites:[],total:1}));await pending;await new Promise(setImmediate);
  assert.equal(ui.state.runs[0].target_url,'https://b.test');assert.equal(ui.state.websiteOrigin,'https://b.test');assert.ok(paths.some(path=>path.startsWith('/v1/runs?origin=https%3A%2F%2Fb.test')));
});
test('switcher launches from settings return to the website while manual navigation wins a late admission',async()=>{
  const data=payloads(),ui=workspace({fetch:async(path,options)=>response(options.method==='POST'?{job:{job_id:'new'}}:data[path])});connect(ui);ui.state.view='settings';ui.location.hash='#/settings/models';
  await ui.submitJob({kind:'explore',target_url:'https://new.test'},{fromSwitcher:true});
  assert.equal(ui.state.view,'workspace');assert.equal(ui.state.websiteOrigin,'https://new.test');assert.equal(ui.location.hash,'#/website/https%3A%2F%2Fnew.test');
  let release,entered;const started=new Promise(resolve=>entered=resolve),other=workspace({fetch:async(path,options)=>{
    if(options.method==='POST'){entered();return new Promise(resolve=>release=()=>resolve(response({job:{job_id:'late'}})));}return response(data[path]);
  }});connect(other);other.selectWebsite('https://a.test');
  const pending=other.submitJob({kind:'explore',target_url:'https://a.test/pricing'},{fromSwitcher:true});await started;
  other.selectWebsite('https://b.test');other.location.hash='#/website/https%3A%2F%2Fb.test';release();await pending;
  assert.equal(other.state.websiteOrigin,'https://b.test');assert.equal(other.state.trackedJobId,null);assert.equal(other.location.hash,'#/website/https%3A%2F%2Fb.test');
});

test('workspace filters combine URL/model search, review status and live/test mode',()=>{
  const ui=workspace();ui.state.websitePage='tests';ui.state.runs=[run('pending'),run('done',{summary:{actions:3,pending_findings:0,confirmed_findings:1}}),run('fixture',{config:{training_status:'excluded_fixture',execution_mode:'protocol_fixture'}}),run('broken',{lifecycle:'failed'}),run('replay',{config:{replay_of:{source_run_id:'pending'},execution_mode:'live'}})];
  ui.state.runFilter='needs_review';assert.deepEqual(Array.from(ui.workspaceRuns(),r=>r.run_id),['pending','fixture','broken']);
  ui.state.runMode='live';assert.deepEqual(Array.from(ui.workspaceRuns(),r=>r.run_id),['pending','broken']);
  ui.state.runFilter='attention';assert.equal(ui.workspaceRuns()[0].run_id,'broken');
  ui.state.search='missing';assert.equal(ui.workspaceRuns().length,0);assert.match(ui.home(),/No runs match these filters/);
  ui.state.search='';ui.state.runFilter='all';ui.state.runMode='test';assert.equal(ui.workspaceRuns()[0].run_id,'fixture');
});
test('review totals count original runs and state the latest-fifty scope',()=>{
  const ui=workspace();ui.state.websitePage='tests';ui.state.runs=[run('source'),run('replay',{config:{replay_of:{source_run_id:'source'}},summary:{pending_findings:900,confirmed_findings:900}})];
  const html=ui.home();assert.match(html,/latest 50 runs/);assert.doesNotMatch(html,/>900<|>901</);assert.match(html,/See source finding/);
  ui.state.runs=[run('legacy',{summary:undefined})];assert.match(ui.home(),/Not loaded/);assert.doesNotMatch(ui.home(),/undefined|NaN/);
});
test('workspace setup describes missing dependencies without hiding recorded runs',()=>{
  const ui=workspace();ui.state.runs=[run('recorded')];assert.match(ui.home(),/Ready to explore\?/);assert.match(ui.home(),/recorded.test/);
  Object.assign(ui.state,{settings:{provider:'openrouter',model:'model'},providers:{gateway_ready:true,providers:[{provider:'openrouter',configured:true}]},workers:[{available:true}]});
  assert.equal(ui.workspaceSetup(),'');
});
test('new jobs stay in Workspace, follow exactly one linked run, and retain durable identity',async()=>{
  const job={job_id:'00000000-0000-4000-8000-000000000088',status:'queued',request:{kind:'explore',target_url:'https://test.app'}};
  const data=payloads([job]),ui=workspace({fetch:async(path,options)=>response(options.method==='POST'?{job,reused:false}:data[path])});connect(ui);
  await ui.submitJob({kind:'explore',target_url:'https://test.app'});
  assert.equal(ui.location.hash,'#/website/https%3A%2F%2Ftest.app');assert.equal(ui.state.view,'workspace');assert.equal(ui.state.trackedJobId,job.job_id);assert.equal(ui.saved.get('scout.tracked-job'),job.job_id);
  assert.match(ui.activityView(),/Your test will open here/);assert.equal(ui.followSubmittedJob(),false);
  job.run_id='00000000-0000-4000-8000-000000000099';assert.equal(ui.followSubmittedJob(),true);assert.equal(ui.location.hash,'#/workspace/'+job.run_id);assert.equal(ui.state.trackedJobId,null);assert.equal(ui.followSubmittedJob(),false);
});
test('manual navigation cancels automatic follow intent and late admission does not hijack settings',async()=>{
  let complete,started;const waiting=new Promise(resolve=>{started=resolve;}),data=payloads();
  const ui=workspace({fetch:async(path,options)=>options.method==='POST'?{ok:true,status:202,json:()=>new Promise(resolve=>{complete=resolve;started();})}:response(data[path])});connect(ui);
  const pending=ui.submitJob({kind:'explore',target_url:'https://test.app'});await waiting;
  ui.state.view='settings';ui.location.hash='#/settings';complete({job:{job_id:'job'}});await pending;
  assert.equal(ui.state.trackedJobId,null);assert.equal(ui.location.hash,'#/settings');
  ui.state.trackedJobId='old-job';await ui.route();assert.equal(ui.state.trackedJobId,null);
});
test('a rejected address is explained on the launch field',async()=>{
  const ui=workspace({fetch:async()=>({ok:false,status:403,json:async()=>({error:'target_origin_not_allowed'})})});connect(ui);
  await ui.submitJob({kind:'explore',target_url:'https://10.0.0.8/'});
  assert.match(ui.state.launchError,/http or https/);assert.equal(ui.state.error,'');
  assert.match(ui.home(),/http or https/);assert.doesNotMatch(ui.shell(ui.home()),/Showing the last available data/);
});
test('failed or cancelled admission without a run remains visible to its user',()=>{
  const ui=workspace();ui.state.trackedJobId='job';ui.state.jobs=[{job_id:'job',status:'failed',run_id:null,error:'<script>target failure</script>'}];
  assert.match(ui.activityView(),/Your test could not start/);assert.match(ui.activityView(),/Job job/);assert.doesNotMatch(ui.activityView(),/#\/operations|back office/i);assert.doesNotMatch(ui.activityView(),/<script>/);
  ui.state.jobs[0].status='cancelled';assert.match(ui.activityView(),/cancelled before launch/);assert.equal(ui.followSubmittedJob(),false);
});
const ready=ui=>Object.assign(ui.state,{settings:{provider:'openrouter',model:'model'},providers:{gateway_ready:true,providers:[{provider:'openrouter',configured:true}]},workers:[{available:true}]});
const click=(ui,action,id)=>ui.handlers.click[0]({target:{closest:selector=>selector==='[data-action]'?{dataset:{action,id},tagName:'BUTTON'}:null}});
test('a stopped test starts again with the request that launched it',async()=>{
  const posted=[],ui=workspace({fetch:async(path,options)=>{if(options.method==='POST'){posted.push(JSON.parse(options.body));return response({job:{job_id:'new'},reused:false});}return response(payloads()[path]);}});connect(ui);ready(ui);
  const old={job_id:'old',status:'failed',run_id:'broken',project_id:'project',settings:{viewportProfile:'mobile'},request:{kind:'explore',target_url:'https://broken.test',auth_mode:'sign_in',auto_reproduce:true}};
  const broken=run('broken',{lifecycle:'failed'}),session={session_id:'saved',expires_at:'2999-01-01T00:00:00Z'};old.request.session_id='saved';
  Object.assign(ui.state,{runs:[broken,run('done')],jobs:[old],access:{requests:[],sessions:[session]}});
  const html=ui.home();assert.match(html,/data-action="restart-run" data-id="broken"/);assert.doesNotMatch(html,/data-action="restart-run" data-id="done"/);
  assert.equal(ui.restartRequest('run',broken).session_id,'saved');
  ui.state.submitting=true;assert.match(ui.home(),/data-id="broken" aria-label="Run broken.test again" title="Run again" disabled/);ui.state.submitting=false;
  session.expires_at='2000-01-01T00:00:00Z';await click(ui,'restart-run','broken');
  assert.deepEqual(posted[0],{job_id:'00000000-0000-4000-8000-000000000088',kind:'explore',target_url:'https://broken.test',viewport_profile:'mobile',auth_mode:'sign_in',auto_reproduce:true,project_id:'project'});
  assert.equal(ui.state.trackedJobId,'new');assert.equal(ui.location.hash,'#/website/https%3A%2F%2Fbroken.test');
});
test('a failed model plan names the request, the provider error and the reasoning budget',()=>{
  const ui=workspace(),requestId='f4b6e31f-07ee-4ab5-85d8-dcbc224bb977';
  ui.state.report={run:run('cut-off',{lifecycle:'failed',error:'Model request did not complete; inspect its request ID.'}),actions:[],captures:[],
    events:[{event_type:'model.decision_failed',payload:{request_id:requestId,kind:'plan'}}],
    model_requests:[{request_id:requestId,state:'failed',error:'incomplete_or_unsupported_output',provider:'meta',model:'muse-wonder-1.0'}],
    model_calls:[{request_id:requestId,output_tokens:2048,reasoning_tokens:1594,error:'incomplete_or_unsupported_output'}]};
  const html=ui.runView();
  assert.match(html,/The model answer was cut off/);
  assert.match(html,/Planning the next action with Meta AI \(muse-wonder-1\.0\)/);
  assert.match(html,/incomplete_or_unsupported_output/);
  assert.match(html,/Reasoning used/);assert.match(html,/2,048|2048/);assert.match(html,/1,594|1594/);
  assert.match(html,new RegExp(`Request ${requestId}`));
  assert.doesNotMatch(html,/inspect its request ID/);
  ui.state.report.run.error='page.screenshot: Target crashed';
  assert.match(ui.runView(),/page\.screenshot: Target crashed/);
  assert.doesNotMatch(ui.runView(),/The model answer was cut off/);
  ui.state.report.run.error='<script>alert(1)</script>';
  assert.doesNotMatch(ui.runView(),/<script>alert/);
});
test('a stopped exploration can continue from its recorded pages or start again',async()=>{
  const posted=[],ui=workspace({fetch:async(path,options)=>{if(options.method==='POST'){posted.push(JSON.parse(options.body));return response({job:{job_id:'new'},reused:false});}return response(payloads()[path]);}});connect(ui);ready(ui);
  const stopped=run('stopped',{lifecycle:'failed',config:{runtime_version:'explorer-v1',replay_of:null,viewport_profile:'desktop',auth_mode:'public'}});
  ui.state.report={run:stopped,actions:[],captures:[]};ui.state.runId='stopped';ui.state.runs=[stopped];
  const html=ui.runView();
  assert.match(html,/data-action="continue-run" data-id="stopped"/);assert.match(html,/Continue exploration/);
  assert.match(html,/data-action="restart-run" data-id="stopped"/);assert.match(html,/Run again/);
  assert.match(html,/class="button primary" title="Carry on from the graph explored so far, starting on the page where this run stopped"/);
  assert.match(html,/class="button" title="Start a new test at the same address"/);
  await click(ui,'continue-run','stopped');
  assert.equal(posted[0].continue_from_run_id,'stopped');assert.equal(posted[0].kind,'explore');assert.equal(posted[0].target_url,'https://stopped.test');assert.equal(posted[0].viewport_profile,'desktop');
  ui.state.jobs=[{job_id:'carrying',status:'queued',request:{kind:'explore',target_url:'https://stopped.test',continue_from_run_id:'stopped',viewport_profile:'desktop'},settings:{viewportProfile:'desktop'}}];
  assert.equal(ui.continueRequest(stopped),null,'a continuation of this run is already queued');
  assert.equal(ui.restartRequest('run',stopped).kind,'explore');assert.equal(ui.restartRequest('run',stopped).continue_from_run_id,undefined);
  ui.state.jobs=[{job_id:'fresh',status:'running',request:{kind:'explore',target_url:'https://stopped.test',viewport_profile:'desktop'},settings:{viewportProfile:'desktop'}}];
  assert.equal(ui.restartRequest('run',stopped),null,'a fresh start of the same test is already running');
  assert.equal(ui.continueRequest(stopped).continue_from_run_id,'stopped');
  ui.state.jobs=[];stopped.lifecycle='blocked';assert.equal(ui.continueRequest(stopped),null);assert.equal(ui.restartRequest('run',stopped).kind,'explore');
  stopped.lifecycle='cancelled';stopped.config.resume={previous_run_ids:['a','b','c','d','e']};assert.equal(ui.continueRequest(stopped).continue_from_run_id,'stopped','a long continuation chain can still carry on');
  stopped.config.replay_of={source_action_id:'suspect'};delete stopped.config.resume;assert.equal(ui.continueRequest(stopped),null);
});
test('a run page and an unstarted job offer one restart each',async()=>{
  const posted=[],ui=workspace({fetch:async(path,options)=>{if(options.method==='POST'){posted.push(JSON.parse(options.body));return response({job:{job_id:'new'},reused:false});}return response(payloads()[path]);}});connect(ui);ready(ui);
  ui.state.report={run:run('stopped',{lifecycle:'interrupted'}),actions:[],captures:[]};ui.state.runId='stopped';
  assert.match(ui.runView(),/data-action="restart-run" data-id="stopped" >.*Run again/);
  ui.state.report.run.lifecycle='completed';assert.doesNotMatch(ui.runView(),/restart-run/);
  Object.assign(ui.state,{report:null,runId:null,trackedJobId:'job',jobs:[{job_id:'job',status:'failed',run_id:null,request:{kind:'reproduce',source_action_id:'suspect'}}]});
  assert.match(ui.activityView(),/data-action="restart-job" data-id="job" >.*Try again/);
  await click(ui,'restart-job','job');assert.deepEqual(posted[0],{job_id:'00000000-0000-4000-8000-000000000088',kind:'reproduce',source_action_id:'suspect'});
});
test('resumed, queued, older and verification runs restart only where it is safe',()=>{
  const ui=workspace(),stopped=run('first',{lifecycle:'interrupted'});
  ui.state.jobs=[{job_id:'job',status:'completed',run_id:'second',previous_run_ids:['first'],request:{kind:'explore',target_url:'https://first.test'}}];
  assert.equal(ui.restartRequest('run',stopped),null,'the job continued in a later run');
  ui.state.jobs=[{job_id:'again',status:'queued',settings:{viewportProfile:'desktop'},request:{kind:'explore',target_url:'https://first.test'}}];
  assert.equal(ui.restartRequest('run',stopped),null,'the same test is already queued');
  ui.state.jobs[0].settings.viewportProfile='mobile';
  assert.deepEqual({...ui.restartRequest('run',stopped)},{kind:'explore',target_url:'https://first.test',viewport_profile:'desktop',auth_mode:undefined,auto_reproduce:undefined,app_memory:undefined});
  const replay=run('replay',{lifecycle:'failed',config:{runtime_version:'explorer-v1',replay_of:{source_run_id:'source',source_action_id:'suspect'}}});
  assert.deepEqual({...ui.restartRequest('run',replay)},{kind:'reproduce',source_action_id:'suspect'});
  replay.config.fix_verification={issue_id:'issue'};assert.equal(ui.restartRequest('run',replay),null);
  assert.equal(ui.restartRequest('run',run('fixture',{lifecycle:'failed',config:{runtime_version:'recorder-v1'}})),null);
});
test('an older run keeps the saved sign-in it started with when its job is no longer loaded',async()=>{
  const posted=[],ui=workspace({fetch:async(path,options)=>{if(options.method==='POST'){posted.push(JSON.parse(options.body));return response({job:{job_id:'new'},reused:false});}return response(payloads()[path]);}});connect(ui);ready(ui);
  const session={session_id:'saved',expires_at:'2999-01-01T00:00:00Z'};
  const stopped=run('older',{lifecycle:'interrupted',config:{runtime_version:'explorer-v1',replay_of:null,viewport_profile:'desktop',auth_mode:'sign_in',auth_contexts:[
    {context_id:'saved',session_id:'saved',verification:'saved_session_reused'},
    {context_id:'later',session_id:'later',verification:'account_created_entry_page_sign_out_control'}]}});
  Object.assign(ui.state,{runs:[stopped],jobs:[],access:{requests:[],sessions:[session,{session_id:'later',expires_at:'2999-01-01T00:00:00Z'}]}});
  assert.equal(ui.restartRequest('run',stopped).session_id,'saved','the launch session is reused, not a later sign-in');
  assert.equal(ui.continueRequest(stopped).session_id,'saved');
  await click(ui,'restart-run','older');
  assert.equal(posted[0].session_id,'saved');assert.equal(posted[0].auth_mode,'sign_in');
  session.expires_at='2000-01-01T00:00:00Z';
  assert.equal(ui.restartRequest('run',stopped).session_id,undefined,'an expired launch session is left out');
  assert.equal(ui.continueRequest(stopped).session_id,undefined);
  session.expires_at='2999-01-01T00:00:00Z';session.revoked_at='2026-01-01T00:00:00Z';
  assert.equal(ui.restartRequest('run',stopped).session_id,undefined,'a removed launch session is left out');
  stopped.config.auth_contexts=[{context_id:'later',session_id:'later',verification:'account_created_entry_page_sign_out_control'}];
  delete session.revoked_at;
  assert.equal(ui.restartRequest('run',stopped).session_id,undefined,'a sign-in saved during the run is not the session the run started with');
});
test('refresh rendering preserves a full text selection and marked disclosures',()=>{
  const ui=workspace();connect(ui);const selection=[];let focus=0;
  const input={id:'run-search',dataset:{},selectionStart:2,selectionEnd:7,selectionDirection:'backward',focus(){focus++;},setSelectionRange(...args){selection.push(args);}};
  ui.document.activeElement=input;ui.document.getElementById=id=>id==='run-search'?input:null;
  const details={dataset:{disclosure:'app-access'},open:true},scroll={scrollTop:120,scrollLeft:30};
  ui.node.querySelectorAll=selector=>selector==='details[data-disclosure]'?[details]:selector.includes('.action-list')?[scroll]:[];
  ui.render();ui.render();assert.deepEqual(selection.at(-1),[2,7,'backward']);assert.ok(focus);assert.equal(details.open,true);assert.equal(scroll.scrollTop,120);
});
test('replacing a number field puts the caret back after the digits',()=>{
  const ui=workspace();connect(ui);const writes=[];
  const input={id:'configuration-max_minutes',type:'number',dataset:{},selectionStart:null,selectionEnd:null,selectionDirection:null,focus(){},setSelectionRange(){throw new Error('number inputs have no caret');},get value(){return this.current;},set value(value){writes.push(value);this.current=value;},current:'30'};
  ui.document.activeElement=input;ui.document.getElementById=id=>id==='configuration-max_minutes'?input:null;
  ui.render();assert.deepEqual(writes,['','30']);
});
test('an unfinished number stays on screen while it is being typed',()=>{
  const ui=workspace();connect(ui);ui.node.innerHTML='kept';
  ui.document.activeElement={type:'number',validity:{badInput:true},selectionStart:null};
  ui.render();assert.equal(ui.node.innerHTML,'kept');
});
test('IME input is captured before the deferred composition-end refresh',()=>{
  const ui=workspace();connect(ui);ui.state.websitePage='tests';ui.state.runs=[{run_id:'run',target_url:'https://example.test',lifecycle:'completed',config:{}}];const target={id:'run-search',value:'日本語',dataset:{}};
  ui.handlers.compositionstart[0]({target});ui.handlers.input[0]({target});const before=ui.node.innerHTML;
  ui.handlers.compositionend[0]({target});assert.equal(ui.state.search,'日本語');assert.equal(ui.node.innerHTML,before);
  target.value='日本語入力';ui.handlers.input[0]({target});assert.equal(ui.state.search,'日本語入力');assert.match(ui.node.innerHTML,/日本語入力/);
});
test('image inspection offers actual pixels, fit mode and pending evidence semantics',()=>{
  const ui=workspace(),path='/v1/captures/00000000-0000-4000-8000-000000000001/image';
  assert.match(ui.imagePanel(null,'pending',true),/Evidence is being collected/);assert.doesNotMatch(ui.imagePanel(null,'pending',true),/explicit evidence gap/);
  assert.match(ui.imagePanel(path,'Before screenshot'),/Inspect at full resolution/);
  ui.state.drawer={title:'Screenshot',image:{path,alt:'<script>page</script>',fit:false}};assert.match(ui.drawer(),/native-resolution/);assert.match(ui.drawer(),/Actual pixels/);assert.doesNotMatch(ui.drawer(),/<script>/);
  ui.state.drawer.image.fit=true;assert.match(ui.drawer(),/fit-resolution/);
});
test('run tabs support keyboard navigation and skip link does not change route',()=>{
  const ui=workspace();connect(ui);const keys=ui.documentHandlers.keydown.at(-1),click=ui.documentHandlers.click.at(-1);let focused='';ui.document.getElementById=id=>({focus(){focused=id;},scrollIntoView(){}});
  keys({key:'End',preventDefault(){},target:{closest(){return {dataset:{action:'tab'}};}}});assert.equal(ui.state.tab,'flow');assert.equal(focused,'run-tab-flow');
  click({preventDefault(){},target:{closest(){return true;}}});assert.equal(focused,'main-content');assert.equal(ui.location.hash,'#/workspace');
});
test('closing a drawer restores focus by stable identity after its opener was replaced',()=>{
  const ui=workspace();connect(ui);let dialog=false,focused='';
  const opener={dataset:{action:'zoom-image',path:'/capture'},focus(){focused='new opener';ui.document.activeElement=this;}},old={dataset:{...opener.dataset},isConnected:false};
  const close={dataset:{action:'close-drawer'},focus(){focused='close';ui.document.activeElement=this;}};
  ui.node.querySelector=selector=>selector==='.drawer'?dialog?{}:null:selector==='.drawer button'&&dialog?close:null;
  ui.node.querySelectorAll=selector=>selector==='[data-action]'?dialog?[opener,close]:[opener]:[];
  Object.defineProperty(ui.node,'innerHTML',{get(){return '';},set(html){dialog=html.includes('role="dialog"');}});
  ui.document.activeElement=old;ui.state.drawer={title:'Evidence',raw:{}};ui.render();assert.equal(focused,'close');
  ui.state.drawer=null;ui.render();assert.equal(focused,'new opener');
});
test('private login prompts appear once in Activity and stay out of session content',()=>{
  const ui=workspace();ui.state.runId='run';ui.state.access={requests:[{access_id:'access',run_id:'run',status:'waiting',reason:'login_required',origin:'https://test.app'}],sessions:[]};
  assert.doesNotMatch(ui.shell('Recorded session'),/Open private login/);ui.state.drawer={activity:true,title:'Activity'};const html=ui.shell('Recorded session');assert.equal((html.match(/Open private login/g)||[]).length,1);
});
test('development mode opens the workspace without sending or retaining a bearer token',async()=>{
  const requests=[],data=payloads(),ui=workspace({fetch:async(path,options)=>{requests.push({path,options});return response(path==='/v1/auth-mode'?{mode:'local_development'}:data[path]);}});
  ui.state.token='old-local-token';ui.saved.set('scout.workspace-token',ui.state.token);await ui.bootstrapSession();
  assert.equal(ui.state.connected,true);assert.equal(ui.state.developmentAccess,true);assert.equal(ui.state.token,'');assert.equal(ui.saved.has('scout.workspace-token'),false);
  assert.ok(requests.some(r=>r.path==='/v1/runs'));assert.ok(requests.every(r=>!r.options?.headers?.Authorization));
  assert.match(ui.node.innerHTML,/Paste a URL/);assert.match(ui.node.innerHTML,/id="target-url"/);assert.match(ui.node.innerHTML,/Start testing/);assert.match(ui.node.innerHTML,/sign-in disabled/);assert.doesNotMatch(ui.node.innerHTML,/id="login-form"|Disconnect workspace/);
});
test('normal mode and a failed mode lookup preserve the email and password login',async()=>{
  for(const mode of ['bearer_token','unknown',null]){
    const ui=workspace({fetch:async()=>{if(mode===null)throw new Error('Offline');return response({mode});}});await ui.bootstrapSession();
    assert.equal(ui.state.developmentAccess,false);assert.equal(ui.state.connected,false);assert.match(ui.node.innerHTML,/id="login-form"/);assert.match(ui.node.innerHTML,/id="email"/);assert.match(ui.node.innerHTML,/id="password"/);assert.doesNotMatch(ui.node.innerHTML,/Workspace access token|id="token"/);
  }
});
test('email and password sign-in keeps the password only after the workspace accepts it',async()=>{
  const requests=[],data=payloads(),password='fixture-password-value-000000000000';
  const ui=workspace({FormData:class{get(name){return name==='email'?' admin ':password;}},fetch:async(path,options)=>{requests.push({path,options});if(path==='/v1/workspace-login')return{ok:true,status:200,json:async()=>({ok:true})};return response(path==='/readyz'?{status:'ok'}:data[path]);}});
  await ui.handlers.submit[0]({preventDefault(){},target:{id:'login-form'}});
  assert.equal(ui.state.connected,true);assert.equal(ui.state.token,password);assert.equal(ui.saved.get('scout.workspace-token'),password);
  const login=requests.find(r=>r.path==='/v1/workspace-login');
  assert.equal(JSON.parse(login.options.body).email,'admin');assert.equal(JSON.parse(login.options.body).password,password);
  assert.equal(login.options.headers.Authorization,undefined);
  assert.ok(requests.some(r=>r.path==='/readyz'&&r.options.headers.Authorization==='Bearer '+password));
  assert.match(ui.node.innerHTML,/Paste a URL/);assert.doesNotMatch(ui.node.innerHTML,new RegExp(password));
});
test('a rejected email or password stays on the sign-in screen',async()=>{
  const ui=workspace({FormData:class{get(name){return name==='email'?'someone':'not-the-workspace-password-000000000000';}},fetch:async()=>({ok:false,status:401,json:async()=>({error:'invalid_credentials'})})});
  await ui.handlers.submit[0]({preventDefault(){},target:{id:'login-form'}});
  assert.equal(ui.state.connected,false);assert.equal(ui.state.token,'');assert.equal(ui.saved.has('scout.workspace-token'),false);
  assert.match(ui.node.innerHTML,/Email or password is incorrect/);assert.match(ui.node.innerHTML,/id="login-form"/);
});
test('normal mode uses an existing token and a protected401 returns to token login',async()=>{
  const data=payloads(),headers=[],ui=workspace({fetch:async(path,options)=>{headers.push(options?.headers);return response(path==='/v1/auth-mode'?{mode:'bearer_token'}:data[path]);}});
  ui.state.token='saved-local-token';await ui.bootstrapSession();assert.equal(ui.state.connected,true);assert.ok(headers.some(h=>h?.Authorization==='Bearer saved-local-token'));
  const denied=workspace({fetch:async()=>({ok:false,status:401,json:async()=>({error:'unauthorized'})})});denied.state.connected=true;denied.state.developmentAccess=true;
  await assert.rejects(denied.api('/v1/runs'),/Workspace access is required/);assert.equal(denied.state.developmentAccess,false);assert.equal(denied.state.connected,false);assert.match(denied.node.innerHTML,/id="login-form"/);
});
test('a late tokenless refresh cannot reconnect a closed development session',async()=>{
  const bodies=[];let allStarted;const started=new Promise(resolve=>{allStarted=resolve;});
  const ui=workspace({fetch:async()=>({ok:true,status:200,json:()=>new Promise(resolve=>{bodies.push(resolve);if(bodies.length===4)allStarted();})})});
  ui.state.developmentAccess=true;ui.state.connected=true;const pending=ui.refresh();await started;
  ui.state.developmentAccess=false;ui.state.connected=false;bodies.forEach(resolve=>resolve({runs:[],jobs:[],workers:[],settings:{}}));await pending;
  assert.equal(ui.state.connected,false);assert.equal(ui.state.developmentAccess,false);
});
test('Spekios mode uses the cookie session and clears stale manual credentials',async()=>{
  const data=payloads(),requests=[],ui=workspace({fetch:async(path,options)=>{requests.push({path,options});return response(path==='/v1/auth-mode'?{mode:'spekios'}:path==='/v1/identity'?{workspace_id:'private-workspace'}:data[path]);}});
  ui.state.token='old-token';ui.saved.set('scout.workspace-token','old-token');await ui.bootstrapSession();
  assert.equal(ui.state.browserAuth,true);assert.equal(ui.state.spekiosAuth,true);assert.equal(ui.state.developmentAccess,false);assert.equal(ui.state.connected,true);
  assert.equal(ui.saved.has('scout.workspace-token'),false);assert.ok(requests.every(r=>!r.options?.headers?.Authorization));
});
test('Spekios without a session shows hosted sign-in instead of the token form',async()=>{
  const ui=workspace({fetch:async(path)=>path==='/v1/auth-mode'?response({mode:'spekios'}):{ok:false,status:401,json:async()=>({error:'unauthorized'})}});
  await ui.bootstrapSession();assert.equal(ui.state.connected,false);assert.match(ui.node.innerHTML,/href="\/login"/);assert.doesNotMatch(ui.node.innerHTML,/id="token"|id="login-form"/);
});
test('a late cookie-authenticated refresh cannot reopen an expired session',async()=>{
  const bodies=[];let allStarted;const started=new Promise(resolve=>{allStarted=resolve;});
  const ui=workspace({fetch:async()=>({ok:true,status:200,json:()=>new Promise(resolve=>{bodies.push(resolve);if(bodies.length===4)allStarted();})})});
  ui.state.browserAuth=true;ui.state.connected=true;const pending=ui.refresh();await started;
  ui.state.browserAuth=false;ui.state.connected=false;bodies.forEach(resolve=>resolve({runs:[],jobs:[],workers:[],settings:{}}));await pending;
  assert.equal(ui.state.connected,false);
});

test('a price link routes to Settings → Models, moves to the model’s price and drops the target from the address',async()=>{
  const focused=[],replaced=[],field={focus(){focused.push('saved-0-input_usd_per_million');},scrollIntoView(){}};
  const settings={provider:'meta',model:'muse-spark-1.3',savedModels:[{provider:'meta',model:'muse-spark-1.3'}]};
  const ui=workspace({window:{addEventListener(){},scrollTo(){},history:{replaceState:(_,__,url)=>replaced.push(url)}},fetch:async path=>response({...payloads(),'/v1/browser-jobs':{jobs:[],workers:[],settings,settings_revision:2},'/v1/app-memory':{scopes:[]}}[path]??{})});
  connect(ui);ui.document.getElementById=id=>id==='saved-0-input_usd_per_million'?field:null;
  ui.location.hash='#/settings/models/price/meta%7Cmuse-spark-1.3';await ui.route();
  assert.equal(ui.state.view,'settings');assert.equal(ui.state.settingsSection,'models');
  assert.deepEqual(replaced,['#/settings/models']);assert.deepEqual(focused,['saved-0-input_usd_per_million']);assert.equal(ui.state.priceTarget,null);
  ui.location.hash='#/settings/models/price/%E0%A4%A';await ui.route();assert.equal(ui.state.priceTarget,null,'A malformed target is ignored.');
});

test('background activity and notifications never enter the selected report or open by themselves',async()=>{
  const report={run:run('selected'),actions:[],captures:[]};
  const data=payloads([{job_id:'other-job',status:'running',run_id:'other-run',request:{kind:'explore',target_url:'https://unrelated.test/private'}}]);
  const ui=workspace({fetch:async path=>response(path==='/v1/runs/selected'?report:data[path])});connect(ui);
  Object.assign(ui.state,{runId:'selected',report,websiteOrigin:'https://selected.test',tab:'flow',trackedJobId:'other-job'});
  await ui.refresh();
  assert.equal(ui.state.drawer,null);assert.equal(ui.state.runId,'selected');assert.equal(ui.state.tab,'flow');assert.equal(ui.state.websiteOrigin,'https://selected.test');assert.equal(ui.location.hash,'#/workspace');
  const selected=ui.shell(ui.runView());assert.doesNotMatch(selected,/https:\/\/unrelated.test\/private|View run|Stop run|activity-card/);
  ui.state.error='<script>refresh failure</script>';assert.doesNotMatch(ui.shell(ui.runView()),/refresh failure|Showing the last available data/);
  await click(ui,'open-activity');
  assert.equal(ui.state.runId,'selected');assert.equal(ui.state.tab,'flow');assert.equal(ui.state.websiteOrigin,'https://selected.test');
  const open=ui.drawer();assert.match(open,/role="dialog"/);assert.match(open,/Across all websites/);assert.match(open,/https:\/\/unrelated.test\/private/);assert.match(open,/data-action="cancel-job" data-id="other-job"/);assert.match(open,/#\/workspace\/other-run/);assert.match(open,/refresh failure/);assert.doesNotMatch(open,/<script>/);
  await click(ui,'close-drawer');assert.equal(ui.state.drawer,null);assert.equal(ui.state.runId,'selected');
});
test('Activity stays live while open and evidence drawers keep their polling pause',async()=>{
  let poll,requests=0;const data=payloads([{job_id:'job',status:'running',request:{kind:'explore',target_url:'https://other.test'}}]);
  const ui=workspace({setInterval(fn,ms){if(ms===5000)poll=fn;},fetch:async path=>{requests++;return response(data[path]);}});connect(ui);ui.selectWebsite('https://selected.test');
  await click(ui,'open-activity');poll();await new Promise(setImmediate);
  assert.equal(requests,4);assert.equal(ui.state.drawer.activity,true);assert.match(ui.drawer(),/other.test/);
  data['/v1/browser-jobs'].jobs[0].status='completed';poll();await new Promise(setImmediate);
  assert.equal(requests,8);assert.match(ui.activityButton(),/0 running/);assert.match(ui.drawer(),/Completed/);assert.equal(ui.state.websiteOrigin,'https://selected.test');
  ui.state.drawer={title:'Evidence',raw:{}};poll();await new Promise(setImmediate);assert.equal(requests,8);
});
test('Activity shows recent results once and keeps an older failed admission available',()=>{
  const ui=workspace();ui.state.trackedJobId='failed';ui.state.jobs=[{job_id:'failed',status:'failed',error:'worker unavailable',request:{kind:'explore',target_url:'https://old.test'}}];
  for(let i=0;i<12;i++)ui.state.jobs.push({job_id:'job-'+i,status:'completed',run_id:'run-'+i,finished_at:'2026-11-01T12:'+String(i).padStart(2,'0')+':00Z',request:{kind:'explore',target_url:'https://done.test'}});
  const html=ui.activityView();assert.equal((html.match(/class="activity-card"/g)||[]).length,11);assert.equal((html.match(/Your test could not start/g)||[]).length,1);assert.match(html,/#\/workspace\/run-11/);assert.doesNotMatch(html,/#\/workspace\/run-0"/);
  assert.match(ui.activityButton(),/0 running, 1 notifications/);
});

test('desktop and mobile Activity controls have distinct focus identities',()=>{
  const ui=workspace(),html=ui.shell('Recorded session');assert.equal((html.match(/id="activity-trigger"/g)||[]).length,1);assert.equal((html.match(/id="activity-trigger-mobile"/g)||[]).length,1);
});

test('viewing the current run from Activity closes the panel without resetting its tab',async()=>{
  const ui=workspace();connect(ui);Object.assign(ui.state,{runId:'current',report:{run:run('current'),actions:[],captures:[]},tab:'flow',drawer:{activity:true,title:'Activity'}});
  await click(ui,'activity-view-run','current');assert.equal(ui.state.drawer,null);assert.equal(ui.state.tab,'flow');assert.equal(ui.state.runId,'current');
  ui.state.drawer={activity:true,title:'Activity'};await click(ui,'activity-view-run','other');assert.equal(ui.state.drawer,null);assert.equal(ui.location.hash,'#/workspace/other');
});


test('the workspace switcher uses Docker hostname handling and updates guidance without replacing the input',async()=>{
  const posts=[],data=payloads(),hint={textContent:'',className:'',removeAttribute(){}},input={invalid:true,removeAttribute(){this.invalid=false;}};
  class LocalUrlForm extends Map{constructor(form){super(form.fields);}}
  const ui=workspace({FormData:LocalUrlForm,fetch:async(path,options)=>{if(options.method==='POST'){posts.push(JSON.parse(options.body));return response({job:{job_id:'queued'}});}return response(data[path]);}});connect(ui);ready(ui);
  ui.node.querySelector=selector=>selector==='#website-url'?input:selector==='#website-launch-error'?hint:null;
  let html=ui.node.innerHTML;
  ui.handlers.input[0]({target:{id:'website-url',value:'localhost:4100',dataset:{}}});assert.match(hint.textContent,/host.docker.internal:4100/);assert.equal(ui.node.innerHTML,html);assert.equal(input.invalid,false);
  ui.handlers.input[0]({target:{id:'website-url',value:'larchwood:8084/shop',dataset:{}}});assert.doesNotMatch(hint.textContent,/where localhost/);
  await ui.handlers.submit[0]({target:{id:'website-launch-form',fields:[['url','larchwood:8084/shop']]},preventDefault(){}});
  assert.equal(posts[0].target_url,'http://larchwood:8084/shop');assert.equal(ui.state.websiteOrigin,'http://larchwood:8084');
});

test('price links from a website wait for an ongoing refresh before targeting the saved model',async()=>{
  let release,entered;const started=new Promise(resolve=>entered=resolve),settings={provider:'meta',model:'muse-spark-1.3',savedModels:[{provider:'meta',model:'muse-spark-1.3'}]},data=payloads();
  data['/v1/browser-jobs']={jobs:[],workers:[],settings,settings_revision:2};let delay=true;
  const ui=workspace({fetch:async path=>{if(path==='/v1/browser-jobs'&&delay){delay=false;entered();return new Promise(resolve=>release=()=>resolve(response(data[path])));}return response(data[path]);}});connect(ui);ui.selectWebsite('https://app.test');
  const focused=[];ui.document.getElementById=id=>id==='saved-0-input_usd_per_million'?{focus:()=>focused.push(id),scrollIntoView(){}}:null;
  const pending=ui.refresh();await started;ui.location.hash='#/settings/models/price/meta%7Cmuse-spark-1.3';const routed=ui.route();await new Promise(setImmediate);
  assert.equal(ui.state.priceTarget,'meta|muse-spark-1.3','Keep the price target until the saved list has loaded.');release();await pending;await routed;await new Promise(setImmediate);
  assert.equal(ui.state.websiteOrigin,'','Settings cover the whole workspace, so no project stays selected.');assert.equal(ui.state.priceTarget,null);assert.deepEqual(focused,['saved-0-input_usd_per_million']);
});


test('manual navigation cancels a deferred price target before a late refresh completes',async()=>{
  let release,entered;const started=new Promise(resolve=>entered=resolve),data=payloads();let delay=true;
  const ui=workspace({fetch:async path=>{if(path==='/v1/browser-jobs'&&delay){delay=false;entered();return new Promise(resolve=>release=()=>resolve(response(data[path])));}return response(data[path]);}});connect(ui);
  const pending=ui.refresh();await started;ui.location.hash='#/settings/models/price/meta%7Cmuse-spark-1.3';await ui.route();assert.equal(ui.state.priceTarget,'meta|muse-spark-1.3');
  ui.location.hash='#/settings/data';await ui.route();assert.equal(ui.state.priceTarget,null);release();await pending;await new Promise(setImmediate);
  assert.equal(ui.state.settingsSection,'data');assert.equal(ui.state.priceTarget,null);
});


test('Continue exploration remains available in the website overview and scoped history',async()=>{
  const posts=[],data=payloads(),ui=workspace({fetch:async(path,options)=>{if(options.method==='POST'){posts.push(JSON.parse(options.body));return response({job:{job_id:'new-continuation'}});}return response(data[path]);}});connect(ui);ready(ui);
  const stopped=run('stopped',{lifecycle:'failed',target_url:'http://larchwood:8084/shop'}),other=run('other',{lifecycle:'failed'});
  ui.state.runs=[stopped,other];ui.selectWebsite('http://larchwood:8084');
  let html=ui.home();assert.match(html,/class="website-test-actions"/);assert.match(html,/data-action="continue-run" data-id="stopped"/);assert.doesNotMatch(html,/data-action="continue-run" data-id="other"/);
  ui.state.websitePage='tests';assert.match(ui.home(),/data-action="continue-run" data-id="stopped"/);
  await click(ui,'continue-run','stopped');assert.equal(posts[0].continue_from_run_id,'stopped');assert.equal(posts[0].target_url,'http://larchwood:8084/shop');assert.equal(ui.state.websiteOrigin,'http://larchwood:8084');
});

test('run again and continue keep the project and the model chosen for that run',()=>{
  const ui=workspace(),model={provider:'anthropic',model:'claude-sonnet-5-5',free_only:true};
  ui.state.jobs=[{job_id:'j',status:'cancelled',run_id:'stopped',project_id:'p',settings:{viewportProfile:'desktop'},request:{kind:'explore',target_url:'https://stopped.test',model}},
    {job_id:'r',status:'failed',request:{kind:'reproduce',source_action_id:'a',model}}];
  const stopped=run('stopped',{lifecycle:'cancelled',target_url:'https://stopped.test'});
  assert.deepEqual({...ui.restartRequest('run',stopped).model},model);assert.equal(ui.restartRequest('run',stopped).project_id,'p');
  assert.deepEqual({...ui.continueRequest(stopped).model},model);
  assert.deepEqual({...ui.restartRequest('job',ui.state.jobs[1]).model},model);
  ui.state.jobs[0].request={kind:'explore',target_url:'https://stopped.test'};
  assert.equal(ui.restartRequest('run',stopped).model,undefined,'Without a run choice the new job resolves its model again.');
});

test('#/workspace lists every project with counts across all of its tests instead of opening the first website',async()=>{
  const paths=[],runs=[run('a',{target_url:'https://a.test/shop',summary:{actions:9,pending_findings:2,confirmed_findings:0}}),run('live',{target_url:'https://b.test/',lifecycle:'active',summary:{actions:42,pending_findings:0}})];
  const websites=[{origin:'https://a.test',run_count:12,target_url:'https://a.test/shop',last_test_at:'2026-11-02T09:00:00Z',active_runs:0,pending_findings:5,confirmed_findings:3},{origin:'https://b.test',run_count:1,target_url:'https://b.test/',last_test_at:'2026-11-02T10:00:00Z',active_runs:1,pending_findings:0,confirmed_findings:0}];
  const ui=workspace({fetch:async path=>{paths.push(path);return response(path==='/v1/runs'?{runs,websites,total:2}:payloads()[path]);}});connect(ui);
  ui.location.hash='#/workspace';await ui.route();
  assert.equal(ui.state.websitePage,'landing');assert.equal(ui.state.websiteOrigin,'','No project is chosen for the person.');assert.ok(paths.includes('/v1/runs'));
  const html=ui.node.innerHTML;
  assert.match(html,/<h1>Your projects<\/h1>/);assert.match(html,/2 projects · 1 running · 5 findings waiting for review/);
  assert.match(html,/<dt>To review<\/dt><dd class="attention">5<\/dd><\/div><div><dt>Confirmed<\/dt><dd>3<\/dd><\/div><div><dt>Tests<\/dt><dd>12<\/dd>/,'Counts come from every run of the website, not only the loaded page.');
  assert.match(html,/<a class="attention-card" href="#\/workspace\/a\/findings">[\s\S]*?5 findings to review/);
  assert.match(html,/href="#\/workspace\/live"><i class="dot green" aria-hidden="true"><\/i>Running now · 42 steps/);
  assert.match(html,/class="sidebar project-sidebar workspace-sidebar"/);assert.match(html,/Recent projects/);assert.doesNotMatch(html,/website-switcher/);
  assert.match(html,/<div class="breadcrumb">[\s\S]*?<span>All projects<\/span>/);assert.match(html,/id="website-launch-form" class="workspace-launch"/);
  ui.location.hash='#/website/https%3A%2F%2Fa.test';await ui.route();assert.equal(ui.state.websitePage,'overview');assert.equal(ui.state.websiteOrigin,'https://a.test');
  assert.match(ui.node.innerHTML,/<a class="all-projects" href="#\/workspace">/);
  ui.location.hash='#/workspace';await ui.route();assert.equal(ui.state.websiteOrigin,'','Returning to the list leaves the project.');
  ui.state.websites=[{origin:'https://a.test',run_count:1,target_url:'https://a.test/shop'}];
  assert.match(ui.landingView(),/<dd class="attention">2<\/dd>/,'An API without catalog counts falls back to the loaded runs.');
});
test('an empty workspace landing is the first-test page and settings use the workspace sidebar',async()=>{
  const ui=workspace({fetch:async path=>response(payloads()[path])});connect(ui);
  ui.location.hash='#/workspace';await ui.route();
  assert.match(ui.node.innerHTML,/What should we explore\?/);assert.match(ui.node.innerHTML,/id="run-form"/);assert.doesNotMatch(ui.node.innerHTML,/Your projects/);
  ui.location.hash='#/settings/models';await ui.route();
  assert.match(ui.node.innerHTML,/workspace-sidebar/);assert.match(ui.node.innerHTML,/<a class="nav-item active" href="#\/settings" aria-current="page">/);assert.doesNotMatch(ui.node.innerHTML,/website-switcher/);
});
