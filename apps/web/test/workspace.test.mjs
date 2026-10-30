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
  vm.runInContext(appSource('main.js')+'\nglobalThis.testing={state,home,workspaceRuns,workspaceSetup,jobBanner,shell,runView,imagePanel,drawer,render,submitJob,followSubmittedJob,route,bootstrapSession,api,refresh};',sandbox);
  return {...sandbox.testing,node,document,handlers,documentHandlers,location,saved};
}
const run=(id,extra={})=>({run_id:id,target_url:'https://'+id+'.test',lifecycle:'completed',config:{runtime_version:'explorer-v1',replay_of:null,execution_mode:'live',viewport_profile:'desktop'},summary:{actions:3,candidates:1,pending_findings:1,confirmed_findings:0,dismissed_findings:0},...extra});
const payloads=(jobs=[])=>({'/v1/runs':{runs:[]},'/v1/browser-jobs':{jobs,workers:[],settings:{}},'/v1/model-providers':{providers:[]},'/v1/browser-access':{requests:[],sessions:[]}});
const connect=ui=>Object.assign(ui.state,{connected:true,token:'local-test-token'});
const response=value=>({ok:true,status:200,json:async()=>value});

test('workspace filters combine URL/model search, review status and live/test mode',()=>{
  const ui=workspace();ui.state.runs=[run('pending'),run('done',{summary:{actions:3,pending_findings:0,confirmed_findings:1}}),run('fixture',{config:{training_status:'excluded_fixture',execution_mode:'protocol_fixture'}}),run('broken',{lifecycle:'failed'}),run('replay',{config:{replay_of:{source_run_id:'pending'},execution_mode:'live'}})];
  ui.state.runFilter='needs_review';assert.deepEqual(Array.from(ui.workspaceRuns(),r=>r.run_id),['pending','fixture','broken']);
  ui.state.runMode='live';assert.deepEqual(Array.from(ui.workspaceRuns(),r=>r.run_id),['pending','broken']);
  ui.state.runFilter='attention';assert.equal(ui.workspaceRuns()[0].run_id,'broken');
  ui.state.search='missing';assert.equal(ui.workspaceRuns().length,0);assert.match(ui.home(),/No runs match these filters/);
  ui.state.search='';ui.state.runFilter='all';ui.state.runMode='test';assert.equal(ui.workspaceRuns()[0].run_id,'fixture');
});
test('review totals count original runs and state the latest-fifty scope',()=>{
  const ui=workspace();ui.state.runs=[run('source'),run('replay',{config:{replay_of:{source_run_id:'source'}},summary:{pending_findings:900,confirmed_findings:900}})];
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
  assert.equal(ui.location.hash,'#/workspace');assert.equal(ui.state.view,'workspace');assert.equal(ui.state.trackedJobId,job.job_id);assert.equal(ui.saved.get('scout.tracked-job'),job.job_id);
  assert.match(ui.jobBanner(),/Your test will open here/);assert.equal(ui.followSubmittedJob(),false);
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
test('an origin outside the public web is explained on the launch field',async()=>{
  const ui=workspace({fetch:async()=>({ok:false,status:403,json:async()=>({error:'target_origin_not_allowed'})})});connect(ui);
  await ui.submitJob({kind:'explore',target_url:'https://10.0.0.8/'});
  assert.match(ui.state.launchError,/Public https sites/);assert.equal(ui.state.error,'');
  assert.match(ui.home(),/Public https sites/);assert.doesNotMatch(ui.shell(ui.home()),/Showing the last available data/);
});
test('failed or cancelled admission without a run remains visible to its user',()=>{
  const ui=workspace();ui.state.trackedJobId='job';ui.state.jobs=[{job_id:'job',status:'failed',run_id:null,error:'<script>target failure</script>'}];
  assert.match(ui.jobBanner(),/Your test could not start/);assert.match(ui.jobBanner(),/Job job/);assert.doesNotMatch(ui.jobBanner(),/#\/operations|back office/i);assert.doesNotMatch(ui.jobBanner(),/<script>/);
  ui.state.jobs[0].status='cancelled';assert.match(ui.jobBanner(),/cancelled before launch/);assert.equal(ui.followSubmittedJob(),false);
});
test('refresh rendering preserves a full text selection and marked disclosures',()=>{
  const ui=workspace();connect(ui);const selection=[];let focus=0;
  const input={id:'run-search',dataset:{},selectionStart:2,selectionEnd:7,selectionDirection:'backward',focus(){focus++;},setSelectionRange(...args){selection.push(args);}};
  ui.document.activeElement=input;ui.document.getElementById=id=>id==='run-search'?input:null;
  const details={dataset:{disclosure:'app-access'},open:true},scroll={scrollTop:120,scrollLeft:30};
  ui.node.querySelectorAll=selector=>selector==='details[data-disclosure]'?[details]:selector.includes('.action-list')?[scroll]:[];
  ui.render();ui.render();assert.deepEqual(selection.at(-1),[2,7,'backward']);assert.ok(focus);assert.equal(details.open,true);assert.equal(scroll.scrollTop,120);
});
test('IME input is captured before the deferred composition-end refresh',()=>{
  const ui=workspace();connect(ui);ui.state.runs=[{run_id:'run',target_url:'https://example.test',lifecycle:'completed',config:{}}];const target={id:'run-search',value:'日本語',dataset:{}};
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
test('run pages show only one private login prompt',()=>{
  const ui=workspace();ui.state.runId='run';ui.state.access={requests:[{access_id:'access',run_id:'run',status:'waiting',reason:'login_required',origin:'https://test.app'}],sessions:[]};
  const html=ui.shell(ui.jobBanner());assert.equal((html.match(/Open private login/g)||[]).length,1);
});
test('development mode opens the workspace without sending or retaining a bearer token',async()=>{
  const requests=[],data=payloads(),ui=workspace({fetch:async(path,options)=>{requests.push({path,options});return response(path==='/v1/auth-mode'?{mode:'local_development'}:data[path]);}});
  ui.state.token='old-local-token';ui.saved.set('scout.workspace-token',ui.state.token);await ui.bootstrapSession();
  assert.equal(ui.state.connected,true);assert.equal(ui.state.developmentAccess,true);assert.equal(ui.state.token,'');assert.equal(ui.saved.has('scout.workspace-token'),false);
  assert.ok(requests.some(r=>r.path==='/v1/runs'));assert.ok(requests.every(r=>!r.options?.headers?.Authorization));
  assert.match(ui.node.innerHTML,/Paste a URL/);assert.match(ui.node.innerHTML,/id="target-url"/);assert.match(ui.node.innerHTML,/Start testing/);assert.match(ui.node.innerHTML,/sign-in disabled/);assert.doesNotMatch(ui.node.innerHTML,/id="login-form"|Disconnect workspace/);
});
test('normal mode and a failed mode lookup preserve the manual token login',async()=>{
  for(const mode of ['bearer_token','unknown',null]){
    const ui=workspace({fetch:async()=>{if(mode===null)throw new Error('Offline');return response({mode});}});await ui.bootstrapSession();
    assert.equal(ui.state.developmentAccess,false);assert.equal(ui.state.connected,false);assert.match(ui.node.innerHTML,/id="login-form"/);
  }
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
