import {appSource} from './support.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

// Rendering contracts only. No browser or remote provider is controlled here.
function view(){
  const node={innerHTML:'',classList:{add(){},remove(){}},addEventListener(){},querySelectorAll(){return[];}};
  const sandbox={document:{querySelector(){return node;},addEventListener(){}},window:{addEventListener(){}},
    sessionStorage:{getItem(){return null;}},setInterval(){},setTimeout(){return 0;},clearTimeout(){},Map,Set,URL,URLSearchParams,Date,Number,JSON,String,console};
  vm.createContext(sandbox);
  vm.runInContext(appSource('main.js')+'\nglobalThis.testing={state,picker,operations,opsOverview,jobsView,modelsView,eventsView,connections,demoCredits,logsView,mergeLogs,logQuery,freshLogs,stamp,MAX_LOG_ROWS};',sandbox);
  return sandbox.testing;
}
function configured(ui){
  ui.state.workers=[{worker_id:'worker-one',available:true,status:'online',heartbeat_at:'2026-10-28T12:00:00Z'}];
  ui.state.settings={provider:'openrouter',model:'openrouter/free',maxActions:6,viewportProfile:'desktop',allowedOrigins:['https://app.test'],freeOnly:true,autoReproduce:false,maxAutoReproductions:2,maxAutoReplayActions:12};
  ui.state.providers={gateway_ready:true,test_mode:false,providers:[{provider:'openrouter',configured:true,authentication:'api_key'}]};
  ui.state.operations={database:'reachable',active_runs:0,pending_captures:0,pending_artifacts:0,pending_model_payloads:0,pending_runtime_events:0,pending_model_events:0,failed_captures:0};
}
const body=html=>html.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1]||'';
test('demo controls configure the lifetime allowance and accept a write-only shared key',()=>{
  const ui=view();ui.state.demo={enabled:false,configured:true,allowance_usd:1,vault_ready:true,revision:2,api_key:'never-render-this-secret'};
  ui.state.opsTab='credits';ui.state.demoError='<script>bad()</script>';
  const html=ui.operations();
  assert.match(html,/Demo credits/);assert.match(html,/muse-spark-1.3-contributor/);
  assert.match(html,/Allowance per account \(USD\)/);assert.match(html,/value="1"/);
  assert.match(html,/type="password"/);assert.match(html,/Leave empty to keep the saved key/);
  assert.match(html,/Personal models and keys stay available/);
  assert.doesNotMatch(html,/never-render-this-secret|<script>/);assert.match(html,/&lt;script&gt;/);
});
const job=(id,status='queued',mode='live',extra={})=>({job_id:id,status,execution_mode:mode,request:{kind:'explore',target_url:`https://app.test/${id}`},created_at:'2026-10-28T12:00:00Z',...extra});
function report(){
  return {run:{run_id:'run-one',target_url:'https://app.test/checkout',config:{execution_mode:'live'},lifecycle:'completed'},
    model_usage:{known_input_tokens:20,known_output_tokens:null,provider_reported_cost_usd:null,incomplete_usage_attempts:1},
    model_requests:[
      {request_id:'assessment-one',action_id:'action-one',provider:'openai',model:'test-model-a',state:'completed',attempt_count:1,execution_mode:'live'},
      {request_id:'plan-two',action_id:null,provider:'openrouter',model:'test-model-b:free',state:'failed',attempt_count:1,execution_mode:'protocol_fixture',error:'Fixture provider failure'},
      {request_id:'navigation-three',action_id:'action-three',provider:'anthropic',model:'test-model-c',state:'queued',attempt_count:0,execution_mode:'live'},
    ],
    model_calls:[{request_id:'assessment-one',input_tokens:20,output_tokens:null,usage_status:'partial'},{request_id:'plan-two',input_tokens:0,output_tokens:0,usage_status:'reported'}],
    graph:{decisions:[{request_id:'assessment-one',kind:'assessment'},{request_id:'plan-two',kind:'plan'}]},
    events:[{event_id:'event-three',seq:3,event_type:'model.decision_requested',action_id:'action-three',payload:{request_id:'navigation-three',kind:'navigation_prediction'}}],
  };
}

test('operations exposes back office navigation and a run picker with escaped target data',()=>{
  const ui=view(),attack='<img src=x onerror="bad()">';configured(ui);
  ui.state.runs=[{run_id:'run-one',target_url:'https://app.test/'+attack}];ui.state.runId='run-one';
  ui.state.lastUpdatedAt='2026-10-28T12:00:00Z';
  const html=ui.operations();assert.match(html,/Back office/);assert.match(html,/backoffice-nav/);assert.match(html,/Browser jobs/);assert.match(html,/Model calls/);assert.match(html,/Connections/);assert.match(html,/Last refreshed/);
  assert.match(html,/id="ops-tab-overview"[^>]*role="tab"[^>]*aria-selected="true"[^>]*aria-controls="ops-panel"[^>]*tabindex="0"/);
  assert.match(html,/id="ops-tab-jobs"[^>]*aria-selected="false"[^>]*tabindex="-1"/);
  assert.match(html,/id="ops-panel" role="tabpanel" aria-labelledby="ops-tab-overview"/);
  ui.state.opsTab='models';const models=ui.operations();
  assert.match(models,/id="ops-tab-models"[^>]*aria-selected="true"[^>]*tabindex="0"/);
  assert.match(models,/id="ops-panel" role="tabpanel" aria-labelledby="ops-tab-models"/);
  assert.match(ui.picker(),/selected/);assert.ok(!ui.picker().includes('<img src=x'));
  ui.state.opsTab='missing-tab';assert.doesNotThrow(()=>ui.operations());assert.match(ui.operations(),/id="ops-panel" role="tabpanel" aria-labelledby="ops-tab-overview"/);
});

test('outbox counters describe delivery rather than claiming bucket or ClickHouse health',()=>{
  const ui=view();configured(ui);
  let html=ui.opsOverview();assert.match(html,/Dispatcher ready/);assert.match(html,/1 online/);assert.match(html,/No pending uploads/);assert.match(html,/No pending events/);
  assert.match(html,/bucket health is not directly probed/);assert.match(html,/ClickHouse health is not directly probed/);assert.doesNotMatch(html,/ClickHouse (healthy|online|reachable)|S3 (healthy|online|reachable)/i);
  assert.match(html,/Reachable at snapshot/);assert.match(html,/no flagged conditions/);
  delete ui.state.operations.pending_model_payloads;delete ui.state.operations.pending_model_events;
  html=ui.opsOverview();assert.match(html,/<span class="service-state pill amber">Unknown<\/span>/);
  ui.state.operations={};ui.state.providers={providers:[]};ui.state.workers=[];
  html=ui.opsOverview();assert.match(html,/No recent heartbeat/);assert.match(html,/gateway has not reported readiness/);assert.match(html,/Unknown mode/);assert.doesNotMatch(html,/\$0\.0000/);
});

test('attention signals distinguish missing workers, configuration, failed records and delivery backlogs',()=>{
  const ui=view();configured(ui);ui.state.workers=[];ui.state.providers.gateway_ready=false;ui.state.providers.providers[0].configured=false;
  ui.state.operations={...ui.state.operations,pending_captures:2,pending_artifacts:1,pending_runtime_events:4,failed_captures:1};
  ui.state.jobs=[job('queued-one'),job('failed-two','failed'),job('interrupted-three','interrupted')];
  const html=ui.opsOverview();assert.match(html,/Browser worker unavailable/);assert.match(html,/1 queued jobs in the latest 3 records/);
  assert.match(html,/Model gateway not ready/);assert.match(html,/Exploration model needs configuration/);assert.match(html,/Recorded capture failures/);
  assert.match(html,/3 captures, artifacts or model payloads/);assert.match(html,/4 runtime and model events/);assert.match(html,/2 failed, interrupted or access-blocked jobs/);
  assert.match(html,/backlog alone does not diagnose a bucket outage/);
});

test('queue filters combine status, mode and search within the latest fifty records',()=>{
  const ui=view();ui.state.jobs=[job('live-queued'),job('fixture-queued','queued','protocol_fixture'),job('live-failed','failed'),job('live-finished','completed')];
  ui.state.jobFilter='queued';ui.state.jobMode='live';ui.state.jobSearch='LIVE-QUEUED';
  let html=ui.jobsView();assert.match(body(html),/live-queued/);assert.doesNotMatch(body(html),/fixture-queued|live-failed|live-finished/);assert.match(html,/Showing 1 of the latest 4 jobs/);
  ui.state.jobFilter='attention';ui.state.jobSearch='';html=ui.jobsView();assert.match(body(html),/live-failed/);assert.doesNotMatch(body(html),/live-queued/);
  ui.state.jobSearch='not present';assert.match(ui.jobsView(),/No matching browser jobs/);
  assert.match(ui.jobsView(true),/live-queued/);assert.doesNotMatch(ui.jobsView(true),/id="job-search"/);
  ui.state.jobs=Array.from({length:51},(_,i)=>job(`entry-${i}`));ui.state.jobFilter='all';ui.state.jobMode='all';ui.state.jobSearch='entry-50';
  html=ui.jobsView();assert.match(html,/latest 50 jobs returned/);assert.match(html,/No matching browser jobs/);assert.doesNotMatch(body(html),/entry-50/);
});

test('queue preserves stop controls, terminal outcomes and text escaping',()=>{
  const ui=view(),attack='<img src=x onerror="bad()"><script>bad()</script>';
  ui.state.jobs=[job('active-one','running','live',{run_id:'run-one',worker_id:'worker-one',started_at:'2026-10-28T12:00:00Z'}),job('cancelled-two','cancelled',undefined),job('failed-three','failed','live',{error:attack,request:{kind:'explore',target_url:'https://app.test/'+attack}})];
  let html=ui.jobsView();assert.match(html,/data-action="cancel-job" data-id="active-one"/);assert.match(html,/#\/models\/run-one/);assert.match(html,/Cancelled before launch/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>|<img src=x/);
  ui.state.jobs=[];html=ui.jobsView();assert.match(html,/No queued browser jobs/);assert.match(html,/Start an exploration in the workspace/);
  ui.state.jobs=[job('unknown-mode','completed',null)];assert.match(body(ui.jobsView()),/Unknown mode/);
});

test('model views combine independent purpose, provider, state and search filters',()=>{
  const ui=view();ui.state.report=report();ui.state.modelProvider='openai';ui.state.modelStatus='completed';ui.state.modelPurpose='assessment';ui.state.modelSearch='assessment-one';
  let html=ui.modelsView();assert.match(body(html),/test-model-a/);assert.doesNotMatch(body(html),/test-model-b|test-model-c/);assert.match(html,/1 of 3 logical requests/);assert.match(html,/Action action-o/);
  assert.match(html,/id="model-provider"/);assert.match(html,/id="model-status"/);assert.match(html,/id="model-purpose"/);
  assert.match(html,/whole run and do not change with the filters/);assert.match(html,/≥ 20/);assert.match(html,/Unknown/);assert.doesNotMatch(html,/\$0\.0000/);
  ui.state.modelPurpose='plan';assert.match(ui.modelsView(),/No matching model requests/);
  ui.state.modelProvider='all';ui.state.modelStatus='all';ui.state.modelPurpose='navigation_prediction';ui.state.modelSearch='';
  html=ui.modelsView();assert.match(body(html),/test-model-c/);assert.doesNotMatch(body(html),/test-model-a|test-model-b/);
});

test('request rows retain zero, unknown and partial tokens and distinguish fixture calls',()=>{
  const ui=view();ui.state.report=report();
  let rows=body(ui.modelsView());assert.match(rows,/≥ 20/);assert.match(rows,/>0<\/td>/);assert.match(rows,/Unknown/);assert.match(rows,/Simulated/);assert.match(rows,/Live/);
  const attack='<script>bad()</script>';ui.state.report.model_requests[0].model=attack;ui.state.report.model_requests[0].error=attack;ui.state.report.model_requests[0].request_id=attack;
  const html=ui.modelsView();assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);
  ui.state.report.model_requests=[];assert.match(ui.modelsView(),/No model calls/);ui.state.report=null;assert.match(ui.modelsView(),/Choose a run/);
});

test('events filter ordered IDs and sequences with clear empty states and escaped payloads',()=>{
  const ui=view(),attack='<script>bad()</script>';ui.state.report=report();ui.state.report.events.push({event_id:'event-four',seq:42,event_type:attack,action_id:'action-four',payload:{text:attack}});
  ui.state.eventSearch='42';let html=ui.eventsView();assert.match(html,/1 of 2 events/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);assert.match(html,/Action <span class="mono">action-four<\/span>/);
  ui.state.eventSearch='not-present';assert.match(ui.eventsView(),/No matching events/);ui.state.report.events=[];assert.match(ui.eventsView(),/No execution events/);
  ui.state.report=null;assert.match(ui.eventsView(),/Choose a run/);
});

test('connections expose read-only scoped configuration without inventing provider health or subscription access',()=>{
  const ui=view();configured(ui);ui.state.providers.test_mode=true;ui.state.providers.providers[0].authentication='test_fixture';
  ui.state.settings.allowedOrigins=['https://app.test/<script>bad()</script>'];ui.state.settings.model='<img src=x onerror="bad()">';
  const html=ui.connections();assert.match(html,/Read-only local configuration/);assert.match(html,/not proof of a successful live provider request/);assert.match(html,/Simulated responses/);assert.match(html,/Provider execution mode/);assert.match(html,/OpenRouter free-only restriction/);assert.match(html,/Additional replay actions in total/);
  assert.match(html,/Authentication for model subscriptions/);assert.match(html,/Not implemented/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>|<img src=x/);assert.doesNotMatch(html,/<input[^>]*type="password"/);
  ui.state.providers={providers:[]};assert.match(ui.connections(),/No provider status available/);
});

test('missing usage stays unknown and provider cards include every configured provider',()=>{
  const ui=view();ui.state.usage={known_input_tokens:null,known_output_tokens:null,provider_reported_cost_usd:null,unpriced_attempts:1};
  assert.match(ui.opsOverview(),/Unknown/);assert.ok(!ui.opsOverview().includes('$0.0000'));
  ui.state.providers={providers:[{provider:'openrouter',configured:false,authentication:'api_key'},{provider:'meta',configured:true,authentication:'api_key'}]};
  assert.match(ui.connections(),/Not configured/);assert.match(ui.connections(),/Meta AI/);assert.match(ui.connections(),/provider-logo">M</);
  assert.doesNotMatch(ui.connections(),/Saved app sessions|Exploration defaults/);
});

test('terminal jobs have no stop control and automatic child jobs link to their parent run inside the back office',()=>{
  const ui=view();ui.state.jobs=[{job_id:'id',status:'cancelled',request:{kind:'explore'},run_id:null}];
  assert.match(ui.jobsView(),/Cancelled before launch/);assert.doesNotMatch(ui.jobsView(),/Awaiting worker|data-action="cancel-job"/);
  ui.state.jobs=[{job_id:'parent',status:'completed',request:{kind:'explore',target_url:'https://app.test'},run_id:'run'},{job_id:'child',parent_job_id:'parent',automatic_source_action_id:'candidate',status:'queued',request:{kind:'reproduce',source_action_id:'candidate'}}];
  const jobs=ui.jobsView();assert.match(jobs,/Automatic reproduction/);assert.match(jobs,/#\/models\/run/);assert.match(jobs,/Parent exploration/);
});

test('the back office never links into the customer workspace',()=>{
  const ui=view();configured(ui);ui.state.report=report();ui.state.runs=[{run_id:'run-one',target_url:'https://app.test/checkout'}];ui.state.runId='run-one';
  ui.state.jobs=[job('active-one','running','live',{run_id:'run-one'}),job('child','queued','live',{parent_job_id:'missing'})];
  for(const tab of ['overview','jobs','models','events','connections']){ui.state.opsTab=tab;assert.doesNotMatch(ui.operations(),/#\/workspace|href="\/(connect|issues)?"/,tab);}
});

function interactive(options={}){
  const handlers={},documentHandlers={},saved=new Map(),replaced=[],node={innerHTML:'',classList:{add(){},remove(){}},querySelectorAll(){return[];},addEventListener(type,fn){(handlers[type]??=[]).push(fn);}};
  const document={activeElement:null,querySelector(){return node;},getElementById(){return null;},addEventListener(type,fn){(documentHandlers[type]??=[]).push(fn);}};
  const location={hash:'#/overview'},sandbox={document,location,history:{replaceState(_,__,hash){replaced.push(hash);}},window:{addEventListener(){}},sessionStorage:{getItem:key=>saved.get(key)||null,setItem:(key,value)=>saved.set(key,value),removeItem:key=>saved.delete(key)},setInterval(){},setTimeout(){return 0;},clearTimeout(){},AbortSignal,URL,...options};
  vm.createContext(sandbox);vm.runInContext(appSource('main.js')+'\nglobalThis.testing={state,route,render,bootstrapSession,tabHash};',sandbox);
  return {...sandbox.testing,node,document,documentHandlers,location,saved,replaced};
}
const response=value=>({ok:true,status:200,json:async()=>value});
const payloads={'/v1/runs':{runs:[]},'/v1/browser-jobs':{jobs:[],workers:[],settings:{}},'/v1/model-providers':{providers:[]},'/v1/operations':{},'/v1/usage':{}};

test('hash routes select a tab and a run, and keyboard tabs keep the address in sync',async()=>{
  const run='00000000-0000-4000-8000-000000000001',ui=interactive({fetch:async path=>response(path.startsWith('/v1/runs/')?report():payloads[path])});
  Object.assign(ui.state,{connected:true,developmentAccess:true});ui.location.hash='#/models/'+run;await ui.route();
  assert.equal(ui.state.opsTab,'models');assert.equal(ui.state.runId,run);assert.equal(ui.tabHash('events'),'#/events/'+run);
  ui.location.hash='#/not-a-tab';await ui.route();assert.equal(ui.state.opsTab,'overview');assert.equal(ui.state.runId,null);
  let focused='';ui.document.getElementById=id=>({focus(){focused=id;}});
  ui.documentHandlers.keydown.at(-1)({key:'ArrowRight',preventDefault(){},target:{closest(){return {dataset:{action:'ops-tab'}};}}});
  assert.equal(ui.state.opsTab,'jobs');assert.equal(focused,'ops-tab-jobs');assert.equal(ui.replaced.at(-1),'#/jobs');
});

test('operator sign-in uses its own session key and development mode sends no bearer token',async()=>{
  const requests=[],ui=interactive({fetch:async(path,options)=>{requests.push({path,options});return response(path==='/v1/auth-mode'?{mode:'local_development'}:payloads[path]);}});
  ui.saved.set('scout.backoffice-token','old-operator-token');ui.state.token='old-operator-token';await ui.bootstrapSession();
  assert.equal(ui.state.developmentAccess,true);assert.equal(ui.saved.has('scout.backoffice-token'),false);assert.ok(requests.every(r=>!r.options?.headers?.Authorization));
  assert.match(ui.node.innerHTML,/BACK OFFICE/);assert.doesNotMatch(ui.node.innerHTML,/id="login-form"/);
  const locked=interactive({fetch:async()=>response({mode:'bearer_token'})});await locked.bootstrapSession();
  assert.match(locked.node.innerHTML,/Operator access token/);assert.match(locked.node.innerHTML,/id="login-form"/);
});

const line=(id,ts,extra={})=>({log_id:id,ts,service:'api',replica:'api-1',stream:'stdout',level:'info',message:'http_request',fields:null,run_id:null,request_id:null,...extra});
test('logs tab streams structured Meta calls with escaped text and run actions',()=>{
  const ui=view(),run='0b6f4c53-6d3d-4a0e-9a59-3c7f5f0f6a11';configured(ui);
  ui.state.opsTab='logs';
  ui.state.logs.services=[{service:'api',last_seen:'2026-11-04T10:12:03Z',lines:12},{service:'browser-worker',last_seen:'2026-11-04T10:12:03Z',lines:3}];
  ui.state.logs.exclude.add('evidence');ui.state.logs.checkedAt='2026-11-04T10:12:04Z';
  ui.mergeLogs(ui.state.logs.rows,[
    line('b','2026-11-04T10:12:03.200000000Z',{level:'info',message:'model_call_finished',run_id:run,request_id:run,fields:{provider:'meta',model:'muse-spark-1.3',http_status:200,elapsed_ms:1834,input_tokens:3120,output_tokens:240,request_id:run}}),
    line('a','2026-11-04T10:12:03.100000000Z',{service:'browser-worker',level:'error',message:'<img src=x onerror="bad()"> Catalogue failure'}),
    line('c','2026-11-04T10:12:03.300000000Z',{level:'debug'}),
  ],ui.state.logs.ids);
  const html=ui.operations();
  assert.match(html,/id="ops-tab-logs"[^>]*aria-selected="true"/);
  assert.match(html,/Service logs/);assert.match(html,/role="log"/);assert.match(html,/Live · checked/);
  assert.ok(html.indexOf('data-log="a"')<html.indexOf('data-log="b"')&&html.indexOf('data-log="b"')<html.indexOf('data-log="c"'));
  assert.match(html,/class="log-row error"/);assert.match(html,/class="log-row debug"/);
  assert.match(html,/<strong class="log-text">model_call_finished<\/strong>/);
  assert.match(html,/provider=<\/span>meta/);assert.match(html,/http_status=<\/span>200/);assert.match(html,/request_id=<\/span>0b6f4c53</);
  assert.ok(!html.includes('<img src=x'));assert.match(html,/&lt;img src=x/);
  assert.match(html,new RegExp(`data-action="log-run" data-run="${run}"`));assert.match(html,new RegExp(`href="#/models/${run}"`));
  assert.match(html,/data-service="evidence" aria-pressed="false"/);assert.match(html,/data-service="api" aria-pressed="true"/);
  assert.match(html,/Pick a run above to filter by it/);
  ui.state.runId=run;ui.state.logs.runOnly=true;assert.match(ui.operations(),/id="log-run-only" checked/);
  ui.state.logs.follow=false;ui.state.logs.unseen=4;assert.match(ui.operations(),/4 new lines · jump to latest/);
});

test('log merging deduplicates by id, keeps time order and caps the buffer',()=>{
  const ui=view(),rows=[],ids=new Set();
  let result=ui.mergeLogs(rows,[line('b','2026-11-04T10:00:02.000000000Z'),line('a','2026-11-04T10:00:01.000000000Z')],ids);
  assert.equal(result.added,2);assert.deepEqual(rows.map(r=>r.log_id),['a','b']);
  result=ui.mergeLogs(rows,[line('b','2026-11-04T10:00:02.000000000Z'),line('late','2026-11-04T10:00:01.500000000Z'),{ts:'x'}],ids);
  assert.equal(result.added,1);assert.deepEqual(rows.map(r=>r.log_id),['a','late','b']);
  result=ui.mergeLogs(rows,[line('c','2026-11-04T10:00:03.000000000Z'),line('d','2026-11-04T10:00:04.000000000Z')],ids,3);
  assert.equal(result.trimmed,2);assert.deepEqual(rows.map(r=>r.log_id),['b','c','d']);assert.ok(!ids.has('a')&&ids.has('d'));
  assert.equal(ui.MAX_LOG_ROWS,1500);
});

test('log queries carry the level, exclusions, search, run and tail cursor',()=>{
  const ui=view(),logs=ui.freshLogs();
  assert.equal(ui.logQuery(logs,null),'/v1/admin/logs?level=info&limit=300');
  logs.level='warning';logs.exclude=new Set(['evidence','browser-sandbox']);logs.q='  model_call ';logs.runOnly=true;
  const url=new URL(ui.logQuery(logs,'run-one',{after:'17_ffffffff-ffff-ffff-ffff-ffffffffffff'}),'http://x');
  assert.equal(url.searchParams.get('level'),'warning');assert.equal(url.searchParams.get('exclude'),'browser-sandbox,evidence');
  assert.equal(url.searchParams.get('q'),'model_call');assert.equal(url.searchParams.get('run_id'),'run-one');
  assert.equal(url.searchParams.get('after'),'17_ffffffff-ffff-ffff-ffff-ffffffffffff');
  logs.runOnly=false;assert.equal(new URL(ui.logQuery(logs,'run-one'),'http://x').searchParams.get('run_id'),null);
  const reset=ui.freshLogs(logs);assert.equal(reset.level,'warning');assert.equal(reset.rows.length,0);assert.equal(reset.generation,logs.generation+1);
  assert.equal(ui.stamp('nonsense').time,'nonsense');assert.match(ui.stamp('2026-11-04T10:12:03.123456789Z').time,/^\d\d:\d\d:03\.123$/);
});

test('logs explain an empty collector, unmatched filters, a cleared view and an unavailable service',()=>{
  const ui=view();configured(ui);ui.state.opsTab='logs';
  assert.match(ui.operations(),/No logs collected yet[\s\S]*docker compose up -d log-socket log-collector/);
  ui.state.logs.services=[{service:'api',lines:1}];ui.state.logs.q='nothing';
  assert.match(ui.operations(),/No matching lines/);
  ui.state.logs.cleared='2026-11-04T10:12:04Z';assert.match(ui.operations(),/View cleared/);
  ui.state.logs.error='Logs are unavailable. Check that the log-collector service is running and the ClickHouse schema is applied.';
  assert.match(ui.operations(),/Logs unavailable[\s\S]*log-collector service is running/);
  ui.state.logs.live=false;assert.match(ui.operations(),/Paused/);
});

