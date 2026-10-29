import {uiSource} from './test-support/source.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

// Rendering contracts only. No browser or remote provider is controlled here.
function view(){
  const node={innerHTML:'',classList:{add(){},remove(){}},addEventListener(){},querySelectorAll(){return[];}};
  const sandbox={document:{querySelector(){return node;},addEventListener(){}},window:{addEventListener(){}},
    sessionStorage:{getItem(){return null;}},setInterval(){},setTimeout(){return 0;},clearTimeout(){},Map,Set,URL,Date,Number,JSON,String,console};
  vm.createContext(sandbox);
  vm.runInContext(uiSource('app.js')+'\nglobalThis.testing={state,picker,operations,opsOverview,jobsView,modelsView,eventsView,connections};',sandbox);
  return sandbox.testing;
}
function configured(ui){
  ui.state.workers=[{worker_id:'worker-one',available:true,status:'online',heartbeat_at:'2026-10-28T12:00:00Z'}];
  ui.state.settings={provider:'openrouter',model:'openrouter/free',maxActions:6,viewportProfile:'desktop',allowedOrigins:['https://app.test'],freeOnly:true,autoReproduce:false,maxAutoReproductions:2,maxAutoReplayActions:12};
  ui.state.providers={gateway_ready:true,test_mode:false,providers:[{provider:'openrouter',configured:true,authentication:'api_key'}]};
  ui.state.operations={database:'reachable',active_runs:0,pending_captures:0,pending_artifacts:0,pending_model_payloads:0,pending_runtime_events:0,pending_model_events:0,failed_captures:0};
}
const body=html=>html.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1]||'';
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
  let html=ui.jobsView();assert.match(html,/data-action="cancel-job" data-id="active-one"/);assert.match(html,/#\/workspace\/run-one/);assert.match(html,/Cancelled before launch/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>|<img src=x/);
  ui.state.jobs=[];html=ui.jobsView();assert.match(html,/No queued browser jobs/);assert.match(html,/Start an exploration in the workspace/);
  ui.state.jobs=[job('unknown-mode','completed',null)];assert.match(body(ui.jobsView()),/Unknown mode/);
});

test('model views combine independent purpose, provider, state and search filters',()=>{
  const ui=view();ui.state.report=report();ui.state.modelProvider='openai';ui.state.modelStatus='completed';ui.state.modelPurpose='assessment';ui.state.modelSearch='assessment-one';
  let html=ui.modelsView();assert.match(body(html),/test-model-a/);assert.doesNotMatch(body(html),/test-model-b|test-model-c/);assert.match(html,/1 of 3 logical requests/);assert.match(html,/#\/workspace\/run-one\/action-one/);
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
  ui.state.eventSearch='42';let html=ui.eventsView();assert.match(html,/1 of 2 events/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);assert.match(html,/#\/workspace\/run-one\/action-four/);
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
