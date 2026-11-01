import {appSource} from './support.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

// Pure rendering tests; these do not launch or control a browser.
function view(overrides={}) {
  const node={innerHTML:'',classList:{add(){},remove(){}},addEventListener(){},querySelectorAll(){return[];}};
  const sandbox={document:{querySelector(){return node;},addEventListener(){}},window:{addEventListener(){}},
    sessionStorage:{getItem(){return null;}},setInterval(){},setTimeout(){return 0;},clearTimeout(){},Map,Set,URL,Date,Number,JSON,String,console,...overrides};
  vm.createContext(sandbox);
  vm.runInContext(appSource('main.js')+'\nglobalThis.testing={state,home,settingsView,costStat,usagePanel,runUsage,actionDetail,drawer,planningView,tokenTotal,costTotal,refresh,render,authOptions,normalizeTargetUrl,launchUrlError,accessBanner,savedSessions,runStatus,cancelButton,runView,reviewView,reviewDraft,updateReviewDraft,submitReview,findingStatus,filteredFindings,confirmable,automaticEnabled,automaticOptions,explorationRequest,automaticPanel,automaticTaskActive,cancelAutomatic};',sandbox);
  return sandbox.testing;
}
test('untrusted page titles, expectations and model outputs remain text',()=>{
  const ui=view(),attack='<img src=x onerror="alert(1)"><script>bad()</script>';
  ui.state.runs=[{run_id:'id',target_url:'https://example.com/'+attack,lifecycle:'completed',config:{}}];
  assert.ok(!ui.home().includes('<script>'));
  ui.state.report={run:{config:{},lifecycle:'completed'},actions:[{action_id:'id',ordinal:1,state:'completed',spec:{command:{type:'click',control:{name:attack}},prediction:{expected_result:attack}},assessment:{verdict:'suspect',reason:attack,observed_result:attack}}],captures:[],reproductions:[]};
  ui.state.actionId='id';
  assert.ok(ui.actionDetail().includes('&lt;script&gt;'));
  assert.ok(!ui.actionDetail().includes('<img src=x'));
  ui.state.drawer={title:attack,raw:{message:attack}};
  assert.ok(!ui.drawer().includes('<script>'));
  const selection={purpose:'explore',selected:{name:attack,reason:attack},ranked_paths:[{name:attack,reason:attack,path_state_ids:['state'],likelihood:.7,path_likelihood_score:.5,travel_steps:0}]};
  const html=ui.planningView({states:[{state_id:'state',url:attack,planning:{parent_state_id:null}}],frontier:[],selections:[selection]});
  assert.ok(!html.includes('<script>'));
  assert.match(html,/70\/100/);
  assert.match(html,/Discovery tree/);
  const graph={states:[{state_id:'blank',url:'about:blank',planning:{depth:0}},{state_id:'root',url:'https://app.test/',planning:{depth:0,parent_state_id:null}},{state_id:'deep',url:'https://app.test/a',planning:{depth:1,parent_state_id:'root'}}],
    frontier:[{state_id:'root',status:'attempted',control:{role:'link'}},{state_id:'root',status:'blocked',control:{role:'button'}},{state_id:'root',status:'unexplored',control:{role:'scroll'}},{state_id:'deep',status:'unexplored',control:{role:'button'}},{state_id:'deep',status:'attempted',control:{role:'button'}}],
    selections:[{purpose:'explore',selected:{name:'A',reason:'r'},ranked_paths:[],strategy:{mode:'breadth',shares:{breadth:.6,depth:.25,rewalk:.15}}},{purpose:'explore',selected:{name:'B',reason:'r',rewalk:{}},ranked_paths:[],strategy:{mode:'rewalk',shares:{breadth:.5,depth:.3,rewalk:.2}}}]};
  const coverage=ui.planningView(graph);
  assert.match(coverage,/Depth and coverage/);assert.match(coverage,/1 deep/);
  assert.match(coverage,/<tr><td>0<\/td><td>1<\/td><td>1 \/ 1<\/td><td>100%<\/td><td>1<\/td><\/tr>/,'Scroll affordances and the blank start page are not coverage.');
  assert.match(coverage,/<tr><td>1<\/td><td>1<\/td><td>1 \/ 2<\/td><td>50%<\/td><td>0<\/td><\/tr>/);
  assert.match(coverage,/New territory 1 \(share now 50%\) · Deep journey 0 \(share now 30%\) · Re-walk 1 \(share now 20%\)/);
  assert.match(coverage,/Repeating a recorded transition/);
});
test('the discovery tree lists each screen once, with the action that reached it',()=>{
  const ui=view(),act=(id,name,type='click')=>({action_id:id,ordinal:1,state:'completed',spec:{command:{type,control:{name,role:type==='scroll'?'scroll':'button'}}}});
  ui.state.report={run:{config:{},lifecycle:'completed'},actions:[act('a1','Allow all cookies'),act('a2','Scroll page down','scroll'),act('a3','Open navigation menu'),act('a4','Documentation')],captures:[],reproductions:[]};
  const s=(id,url,parent,planning={})=>({state_id:id,url,planning:{depth:0,parent_state_id:parent,...planning}});
  const graph={states:[s('blank','about:blank',null),s('wall','https://app.test/',null),s('home','https://app.test/','wall',{depth:1}),s('scrolled','https://app.test/','home',{depth:1,screen_state_id:'home'}),s('menu','https://app.test/','scrolled',{depth:2}),s('docs','https://app.test/docs/overview','menu',{depth:3})],
    edges:[{action_id:'a1',from_state_id:'wall',to_state_id:'home'},{action_id:'a2',from_state_id:'home',to_state_id:'scrolled'},{action_id:'a3',from_state_id:'scrolled',to_state_id:'menu'},{action_id:'a4',from_state_id:'menu',to_state_id:'docs'}],
    frontier:[{state_id:'home',control_id:'c1',status:'unexplored',control:{role:'button'}},{state_id:'home',control_id:'c2',status:'unexplored',control:{role:'link'}},{state_id:'home',control_id:'down',status:'attempted',control:{role:'scroll'}},
      {state_id:'scrolled',control_id:'c1',status:'unexplored',control:{role:'button'}},{state_id:'scrolled',control_id:'c2',status:'attempted',control:{role:'link'}}],
    selections:[{purpose:'explore',selected:{name:'A',reason:'r'},ranked_paths:[]}]};
  const html=ui.planningView(graph),tree=html.slice(html.indexOf('class="discovery-tree"'));
  assert.match(tree,/S2<\/span><strong>https:\/\/app.test\/<\/strong><span class="small muted">Entry page/);
  assert.match(tree,/S3<\/span><strong>Allow all cookies<\/strong><span class="small muted">Same address<\/span><span class="small muted">1 tried · 1 untried<\/span>/,'A control tried in any view of the screen is tried.');
  assert.match(tree,/Same screen: S4 after Scroll page down<\/p><ul><li><div><span class="pill">S5<\/span><strong>Open navigation menu<\/strong>/,'What a view found hangs under its screen.');
  assert.doesNotMatch(tree,/S4<\/span>/,'A view is not a node of its own.');
  assert.match(tree,/S6<\/span><strong>Documentation<\/strong><span class="small muted">\/docs\/overview<\/span>/);
  assert.match(html,/<tr><td>1<\/td><td>1<\/td><td>1 \/ 2<\/td><td>50%<\/td><td>0<\/td><\/tr>/,'Coverage counts the screen once.');
});
test('partial token and cost reports are shown as known subtotals',()=>{
  const ui=view();
  assert.equal(ui.tokenTotal({known_input_tokens:null,known_output_tokens:12}), '≥ 12');
  assert.equal(ui.tokenTotal({known_input_tokens:20,known_output_tokens:12,incomplete_usage_attempts:1}), '≥ 32');
  assert.equal(ui.tokenTotal({known_input_tokens:20,known_output_tokens:12,incomplete_usage_attempts:0}), '32');
  assert.equal(ui.tokenTotal({known_input_tokens:null,known_output_tokens:null}), 'Unknown');
  assert.equal(ui.costTotal({provider_reported_cost_usd:'0',unpriced_attempts:1}), '≥ $0.0000');
  assert.equal(ui.costTotal({provider_reported_cost_usd:null,unpriced_attempts:1}), 'Unknown');
});
test('action completion exposes recorded frames and escapes untrusted diagnostics',()=>{
  const ui=view(),attack='<img src=x onerror="bad()">';
  ui.state.report={run:{config:{},lifecycle:'completed'},actions:[{action_id:'id',ordinal:2,spec:{command:{type:'submit',control:{name:'Search'}},prediction:{}},outcome:{status:'timed_out',elapsed_ms:5000,reason:attack,diagnostics:{http_errors:1,request_failures:0,console_errors:1},diagnostic_events:[{kind:'console',level:'error',text:attack,offset_ms:1200}]}}],captures:[],reproductions:[],events:[{action_id:'id',event_type:'action.settling_frame',payload:{frame_id:'frame-id',offset_ms:1200,artifact:{artifact_id:'artifact-id'}}}]};
  ui.state.actionId='id';ui.state.image='frame';ui.state.frameId='frame-id';
  const html=ui.actionDetail();
  assert.match(html,/Submit Search/);assert.match(html,/Unresolved/);assert.match(html,/data-action="settling-frame"/);
  assert.ok(html.includes('/v1/artifacts/artifact-id/content'));assert.ok(html.includes('frame-id'));
  assert.ok(html.includes('&lt;img'));assert.ok(!html.includes('<img src=x'));
  ui.state.report.actions[0].outcome.diagnostics.runtime_blocks=11;
  assert.match(ui.actionDetail(),/11 blocked by runtime/);
  delete ui.state.report.actions[0].outcome;
  assert.match(ui.actionDetail(),/recorded samples remain inspectable/);
  assert.match(ui.actionDetail(),/data-action="settling-frame"/);
});
test('late response bodies cannot reconnect a disconnected workspace',async()=>{
  const bodies=[];
  let allStarted;
  const started=new Promise(resolve=>{allStarted=resolve;});
  const ui=view({AbortSignal,fetch:async()=>({ok:true,status:200,json:()=>new Promise(resolve=>{
    bodies.push(resolve);if(bodies.length===4)allStarted();
  })})});
  ui.state.token='private-session-token';
  ui.state.connected=true;
  const pending=ui.refresh();
  await started;
  ui.state.token='';ui.state.connected=false;
  bodies.forEach(resolve=>resolve({runs:[],jobs:[],workers:[],settings:{}}));
  await pending;
  assert.equal(ui.state.connected,false);
  assert.equal(ui.state.token,'');
  assert.equal(ui.state.runs.length,0);
});
test('an unchanged open run keeps the loaded report',async()=>{
  const calls=[];
  const report={run:{run_id:'run',lifecycle:'completed',config:{}},actions:[{action_id:'kept'}],captures:[],reproductions:[]};
  const ui=view({AbortSignal,fetch:async(path,options)=>{
    calls.push([path,options?.headers?.['If-None-Match']||'']);
    if(path==='/v1/runs/run'&&options?.headers?.['If-None-Match'])return {ok:false,status:304,headers:{get(){return null;}},json:async()=>({})};
    const body=path==='/v1/runs/run'?report:path.split('?')[0]==='/v1/runs'?{runs:[]}:path==='/v1/browser-jobs'?{jobs:[],workers:[],settings:{}}:path==='/v1/model-providers'?{providers:[]}:{requests:[],sessions:[]};
    return {ok:true,status:200,headers:{get(name){return name==='etag'&&path==='/v1/runs/run'?'"abc"':null;}},json:async()=>body};
  }});
  ui.state.token='private-workspace-token';ui.state.connected=true;ui.state.runId='run';
  await ui.refresh();
  assert.equal(ui.state.report.actions[0].action_id,'kept');
  assert.equal(ui.state.reportEtag,'"abc"');
  assert.equal(ui.state.report._etag,undefined);
  ui.state.report.actions[0].action_id='local';
  await ui.refresh();
  assert.equal(ui.state.report.actions[0].action_id,'local');
  assert.ok(calls.some(([path,etag])=>path==='/v1/runs/run'&&etag==='"abc"'));
});
test('login prompts escape target data and saved sessions are scoped to the selected origin and mode',()=>{
  const ui=view(),future=new Date(Date.now()+3600000).toISOString();
  ui.state.url='https://app.test/path';ui.state.access={requests:[{access_id:'id',origin:'<script>bad()</script>',reason:'login_available',status:'waiting'}],sessions:[
    {session_id:'right',origin:'https://app.test',execution_mode:'live',expires_at:future},
    {session_id:'wrong-app',origin:'https://other.test',execution_mode:'live',expires_at:future},
    {session_id:'wrong-mode',origin:'https://app.test',execution_mode:'protocol_fixture',expires_at:future},
  ]};
  assert.ok(ui.authOptions().includes('value="right"'));
  assert.ok(!ui.authOptions().includes('value="wrong-app"'));
  assert.ok(!ui.authOptions().includes('value="wrong-mode"'));
  assert.match(ui.accessBanner(),/Explore public pages/);
  assert.ok(!ui.accessBanner().includes('<script>'));
  assert.match(ui.accessBanner(),/Cancel run/);
  assert.match(ui.savedSessions(),/Remove session/);
  assert.doesNotMatch(ui.savedSessions(),/fixture-only-password|scout_app_session/);
});
test('disconnected providers cannot imply readiness and settings show availability without credentials',()=>{
  const ui=view();
  ui.state.providers={providers:[{provider:'openrouter',configured:false,authentication:'api_key'},{provider:'meta',configured:true,authentication:'api_key'}]};
  assert.match(ui.settingsView(),/Not configured/);
  assert.match(ui.settingsView(),/Meta AI[\s\S]*Available/);
  assert.doesNotMatch(ui.settingsView(),/api_key|<input[^>]*type="password"/);
  assert.match(ui.home(),/disabled/);
});
test('cancellation remains pending until acknowledged and terminal work has no stop control',()=>{
  const ui=view(),run={run_id:'id',lifecycle:'active',config:{runtime_version:'explorer-v1'}};
  assert.match(ui.cancelButton('run',run),/Stop run/);
  run.cancel_requested_at=new Date().toISOString();
  assert.equal(ui.runStatus(run),'cancelling');
  assert.match(ui.cancelButton('run',run),/disabled/);
  run.lifecycle='cancelled';
  assert.equal(ui.runStatus(run),'cancelled');assert.equal(ui.cancelButton('run',run),'');
});

function reviewReport(){
  return {run:{run_id:'run',target_url:'https://example.test',config:{runtime_version:'explorer-v1'},lifecycle:'completed'},model_usage:{},
    actions:[{action_id:'candidate',ordinal:1,state:'completed',before_capture_id:'before',after_capture_id:'after',spec:{command:{type:'click',control:{name:'Open results'}},prediction:{expected_result:'Results open'}},assessment:{verdict:'suspect',expectation_uncertain:false,reason:'Results did not open'}}],
    captures:[{capture_id:'before',status:'available'},{capture_id:'after',status:'available'}],events:[],finding_reviews:[],
    reproductions:[{source_action_id:'candidate',replay_run_id:'replay',result:{outcome:'reproduced',matching_after_state:true,source_capture_ids:['before','after'],replay_capture_ids:['replay-before','replay-after'],confirmed_bug:false}}]};
}
function connectReview(ui,report=reviewReport()){
  ui.state.connected=true;ui.state.token='private-workspace-token';ui.state.runId='run';ui.state.report=report;ui.state.actionId='candidate';return report;
}
function reviewFetch(report){return async path=>({ok:true,status:200,json:async()=>path==='/v1/runs/run'?report:path.split('?')[0]==='/v1/runs'?{runs:[]}:path==='/v1/browser-jobs'?{jobs:[],workers:[],settings:{}}:path==='/v1/model-providers'?{providers:[]}:path==='/v1/browser-access'?{requests:[],sessions:[]}: {}});}

test('human review status uses the latest revision and dismissed candidates leave the pending findings view',()=>{
  const ui=view(),report=connectReview(ui);
  report.actions.push({...report.actions[0],action_id:'dismissed',ordinal:2},{...report.actions[0],action_id:'confirmed',ordinal:3});
  report.finding_reviews=[{action_id:'dismissed',revision:2,disposition:'dismissed',rationale:'Expected behavior'},{action_id:'confirmed',revision:1,disposition:'confirmed',rationale:'Verified product requirement'},{action_id:'dismissed',revision:1,disposition:'needs_review',rationale:'Investigate'}];
  assert.equal(ui.findingStatus(report.actions[1]),'dismissed');
  assert.deepEqual(Array.from(ui.filteredFindings(),a=>a.action_id),['candidate']);
  ui.state.findingFilter='confirmed';assert.deepEqual(Array.from(ui.filteredFindings(),a=>a.action_id),['confirmed']);
  ui.state.findingFilter='dismissed';assert.deepEqual(Array.from(ui.filteredFindings(),a=>a.action_id),['dismissed']);
  ui.state.findingFilter='all';assert.equal(ui.filteredFindings().length,3);
  ui.state.tab='findings';ui.state.findingFilter='needs_review';const html=ui.runView();
  assert.match(html,/Human confirmed/);assert.match(html,/1 human dismissed candidates/);assert.doesNotMatch(html,/data-action="select-action" data-id="dismissed"/);
  ui.state.tab='actions';assert.match(ui.runView(),/data-action="select-action" data-id="dismissed"/);
  assert.equal(report.actions[1].assessment.verdict,'suspect');
});

test('confirmation requires matching reproduction and evidence but does not require a configured provider',()=>{
  const ui=view(),report=connectReview(ui),action=report.actions[0];
  assert.equal(ui.confirmable(action),true);
  assert.match(ui.reviewView(action),/<option value="confirmed"\s*>Confirm product defect/);
  report.reproductions[0].result.matching_after_state=false;assert.equal(ui.confirmable(action),false);
  assert.match(ui.reviewView(action),/<option value="confirmed"\s+disabled>/);
  report.reproductions[0].result.matching_after_state=true;
  report.reproductions[0].result.source_capture_ids=['unrelated','after'];assert.equal(ui.confirmable(action),false);
  report.reproductions[0].result.source_capture_ids=['before','after'];report.captures[0].status='pending';assert.equal(ui.confirmable(action),false);
  report.captures[0].status='available';action.assessment.expectation_uncertain=true;assert.equal(ui.confirmable(action),false);
  action.assessment.expectation_uncertain=false;report.run.lifecycle='active';assert.doesNotMatch(ui.reviewView(action),/<form/);
  report.run.lifecycle='completed';report.run.config.replay_of={source_run_id:'original'};assert.doesNotMatch(ui.reviewView(action),/<form/);
});

test('review decisions, drafts, reviewers and evidence snapshots are escaped in current and historical views',()=>{
  const ui=view(),report=connectReview(ui),attack='<img src=x onerror="bad()"><script>bad()</script>';
  report.finding_reviews=[{review_id:attack,action_id:'candidate',revision:1,disposition:'dismissed',rationale:attack,expectation_basis:attack,reviewer_id:attack,severity:attack,evidence_snapshot:{note:attack}}];
  ui.updateReviewDraft('candidate','rationale',attack);ui.updateReviewDraft('candidate','expectation_basis',attack);
  const html=ui.actionDetail();assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<img src=x'));assert.ok(!html.includes('<script>'));
  assert.match(html,/Full review history/);assert.match(html,/Reviewer &lt;img/);assert.match(html,/Human dismissed/);assert.match(html,/Original AI suspicion/);
});

test('automatic refresh preserves pending review fields and their original concurrency revision',async()=>{
  const refreshed=reviewReport();refreshed.finding_reviews=[{action_id:'candidate',revision:1,disposition:'dismissed',rationale:'Another reviewer decision'}];
  const ui=view({AbortSignal,fetch:reviewFetch(refreshed)});connectReview(ui);
  ui.updateReviewDraft('candidate','rationale','My pending reasoning');ui.updateReviewDraft('candidate','expectation_basis','Documented requirement');ui.updateReviewDraft('candidate','severity','high');ui.updateReviewDraft('candidate','disposition','confirmed');
  await ui.refresh();
  const draft=ui.reviewDraft(ui.state.report.actions[0]);assert.equal(draft.rationale,'My pending reasoning');assert.equal(draft.expectation_basis,'Documented requirement');assert.equal(draft.severity,'high');assert.equal(draft.disposition,'confirmed');assert.equal(draft.revision,0);
  const html=ui.reviewView(ui.state.report.actions[0]);assert.match(html,/My pending reasoning/);assert.match(html,/Current review · revision 1/);assert.match(html,/Human dismissed/);
});

test('review retries reuse the submission UUID and duplicate clicks cannot create concurrent writes',async()=>{
  const requests=[];let resolveFirst;let nextId=0;
  const ui=view({AbortSignal,crypto:{randomUUID:()=>`review-${++nextId}`},fetch:async(path,options)=>{
    requests.push(JSON.parse(options.body));if(requests.length===1)return new Promise(resolve=>{resolveFirst=()=>resolve({ok:false,status:503,json:async()=>({error:'reviews_unavailable'})});});
    return {ok:true,status:201,json:async()=>({review:{review_id:requests[1].review_id,action_id:'candidate',revision:1,disposition:'dismissed',rationale:requests[1].rationale},reused:false})};
  }});
  connectReview(ui);ui.updateReviewDraft('candidate','rationale','The page behaves as documented');ui.updateReviewDraft('candidate','disposition','dismissed');
  const first=ui.submitReview('candidate');await ui.submitReview('candidate');assert.equal(requests.length,1);resolveFirst();await first;
  await ui.submitReview('candidate');assert.equal(requests.length,2);assert.equal(requests[0].review_id,requests[1].review_id);assert.equal(nextId,1);
  assert.equal(ui.findingStatus(ui.state.report.actions[0]),'dismissed');assert.equal(ui.state.report.actions[0].assessment.verdict,'suspect');
});

test('revision conflict refreshes the history, keeps reasoning and asks for an explicit retry against the latest revision',async()=>{
  const report=reviewReport(),updated=reviewReport();updated.finding_reviews=[{review_id:'other',action_id:'candidate',revision:2,disposition:'dismissed',rationale:'Other decision'}];
  const requests=[];let nextId=0;
  const ui=view({AbortSignal,crypto:{randomUUID:()=>`review-${++nextId}`},fetch:async(path,options)=>{
    if(!options.body)return {ok:true,status:200,json:async()=>updated};
    const body=JSON.parse(options.body);requests.push(body);
    return requests.length===1?{ok:false,status:409,json:async()=>({error:'revision_conflict'})}:{ok:true,status:201,json:async()=>({review:{review_id:body.review_id,action_id:'candidate',revision:3,disposition:body.disposition,rationale:body.rationale},reused:false})};
  }});
  connectReview(ui,report);ui.updateReviewDraft('candidate','rationale','Independent reasoning is retained');
  await ui.submitReview('candidate');const draft=ui.reviewDraft(ui.state.report.actions[0]);
  assert.equal(draft.rationale,'Independent reasoning is retained');assert.equal(draft.revision,2);assert.equal(draft.reviewId,null);assert.match(draft.error,/history has been refreshed/);assert.equal(requests.length,1);
  await ui.submitReview('candidate');assert.equal(requests[1].expected_revision,2);assert.notEqual(requests[0].review_id,requests[1].review_id);assert.equal(requests[1].rationale,requests[0].rationale);
});

test('server review rejection preserves a pending decision and confirmation cannot bypass local required fields',async()=>{
  let requests=0;
  const ui=view({AbortSignal,crypto:{randomUUID:()=> 'review-id'},fetch:async()=>{requests++;return {ok:false,status:409,json:async()=>({error:'incomplete_evidence'})};}}),report=connectReview(ui);
  ui.updateReviewDraft('candidate','rationale','A requirement was violated');ui.updateReviewDraft('candidate','disposition','confirmed');
  await ui.submitReview('candidate');assert.equal(requests,0);assert.match(ui.reviewDraft(report.actions[0]).error,/expectation basis/);
  ui.updateReviewDraft('candidate','expectation_basis','The documented product requirement');ui.updateReviewDraft('candidate','severity','high');
  await ui.submitReview('candidate');assert.equal(requests,1);const draft=ui.reviewDraft(report.actions[0]);
  assert.equal(draft.rationale,'A requirement was violated');assert.equal(draft.disposition,'confirmed');assert.equal(draft.severity,'high');assert.match(draft.error,/server could not verify complete evidence/);assert.equal(report.finding_reviews.length,0);
});

test('automatic checks default from settings, retain a user choice and submit an explicit opt-in without requiring a brief',()=>{
  const ui=view();
  assert.equal(ui.automaticEnabled(),false);
  assert.doesNotMatch(ui.automaticOptions(),/type="checkbox" checked/);
  ui.state.settings={autoReproduce:true,maxAutoReproductions:2,maxAutoReplayActions:12};
  assert.equal(ui.automaticEnabled(),true);
  assert.match(ui.automaticOptions(),/up to 2 suspected bugs and 12 additional browser actions in total/);
  ui.state.autoReproduce=false;ui.state.url='https://another.test';
  ui.state.settings={...ui.state.settings,autoReproduce:true};
  assert.equal(ui.automaticEnabled(),false);
  const fields=new Map([['url',' https://app.test/path '],['viewport_profile','mobile'],['session_id','saved-session']]);
  const request=ui.explorationRequest(fields);
  assert.equal(request.target_url,'https://app.test/path');assert.equal(request.auto_reproduce,false);assert.equal(request.auth_mode,'auto');assert.equal(request.session_id,'saved-session');assert.equal(request.viewport_profile,'mobile');assert.ok(!('brief' in request));
  ui.state.autoReproduce=true;assert.equal(ui.explorationRequest(fields).auto_reproduce,true);
  const restored=view({sessionStorage:{getItem:key=>key==='scout.auto-reproduce'?'false':null}});restored.state.settings={autoReproduce:true};assert.equal(restored.automaticEnabled(),false);
});

function automaticTask(overrides={}){
  return {task_id:'task',source_run_id:'run',source_job_id:'parent',source_action_id:'candidate',status:'pending',reason:'queue_capacity',planned_actions:3,child_job_id:null,child_job:null,reproduction:null,...overrides};
}

test('automatic task reservations expose queue and budget reasons without offering duplicate manual dispatch',()=>{
  const ui=view(),report=connectReview(ui);report.reproductions=[];
  report.run.config.automatic_reproduction_policy={enabled:true,max_cases:2,max_actions:12};report.run.auto_reproduction_planned_at='2026-10-28T10:00:00Z';
  report.automatic_reproductions=[automaticTask(),automaticTask({task_id:'other',source_action_id:'budget',status:'skipped',reason:'action_budget_exhausted',planned_actions:0})];
  let html=ui.runView();assert.match(html,/Automatic checks/);assert.match(html,/Waiting for room in the browser queue/);assert.match(html,/Additional action budget exhausted/);assert.match(html,/3 planned browser actions/);assert.match(html,/Stop automatic checks/);
  assert.doesNotMatch(ui.actionDetail(),/data-action="reproduce"/);
  report.automatic_reproductions[0]=automaticTask({status:'queued',child_job_id:'child',child_job:{job_id:'child',status:'running',run_id:'replay'}});
  html=ui.actionDetail();assert.match(html,/#\/workspace\/replay/);assert.match(html,/already scheduled/);assert.doesNotMatch(html,/data-action="reproduce"/);
  report.automatic_reproductions[0].child_job.status='failed';
  assert.match(ui.actionDetail(),/data-action="reproduce"/);
  report.run.auto_reproduction_cancel_id='cancel';report.automatic_reproductions[0].child_job.status='running';
  assert.match(ui.automaticPanel(),/data-id="run" disabled[\s\S]*Stopping automatic checks…/);
  assert.match(ui.automaticPanel(),/Retry stop requests/);
  report.automatic_reproductions[0].child_job.cancel_id='child-stop';
  assert.doesNotMatch(ui.automaticPanel(),/Retry stop requests/);
  report.automatic_reproductions[0].child_job.status='cancelled';report.run.auto_reproduction_cancelled_at='2026-10-28T10:01:00Z';
  assert.doesNotMatch(ui.automaticPanel(),/data-action="cancel-automatic"/);assert.match(ui.automaticPanel(),/Automatic checks stopped/);
});

test('planning can be stopped before tasks exist and completed checks retain outcome and source links',()=>{
  const ui=view(),report=connectReview(ui);report.run.config.automatic_reproduction_policy={enabled:true,max_cases:1,max_actions:8};report.automatic_reproductions=[];
  assert.match(ui.automaticPanel(),/Waiting for exploration to finish/);assert.match(ui.automaticPanel(),/data-action="cancel-automatic"/);
  report.run.auto_reproduction_planned_at='2026-10-28T10:00:00Z';
  assert.doesNotMatch(ui.automaticPanel(),/data-action="cancel-automatic"/);
  report.automatic_reproductions=[automaticTask({status:'queued',reason:'ready',child_job:{status:'completed',run_id:'replay'},reproduction:{status:'completed',replay_run_id:'replay',result:{outcome:'reproduced',reason:'Same failure observed',confirmed_bug:false}}})];
  let html=ui.automaticPanel();assert.match(html,/Reproduced/);assert.match(html,/Same failure observed/);assert.match(html,/Human review is required/);assert.match(html,/data-action="select-action" data-source-action="true" data-id="candidate"/);assert.doesNotMatch(html,/data-action="cancel-automatic"/);
  report.run={...report.run,run_id:'replay',config:{runtime_version:'explorer-v1',replay_of:{source_run_id:'run',source_action_id:'candidate'}}};
  html=ui.automaticPanel();assert.match(html,/Automatic fresh-browser check/);assert.match(html,/#\/workspace\/run\/candidate/);assert.match(html,/href="#\/workspace\/run"/);assert.doesNotMatch(html,/#\/operations|data-action="cancel-automatic"/);
  assert.equal(report.automatic_reproductions[0].reproduction.result.confirmed_bug,false);
});

test('automatic task text and lineage are escaped',()=>{
  const ui=view(),report=connectReview(ui),attack='<img src=x onerror="bad()"><script>bad()</script>';
  report.run.config.automatic_reproduction_policy={enabled:true,max_cases:2,max_actions:12};report.run.auto_reproduction_planned_at='now';
  report.automatic_reproductions=[automaticTask({status:'queued',reason:attack,source_action_id:attack,child_job:{job_id:'child',status:'failed',run_id:'replay',error:attack},reproduction:{result:{outcome:'inconclusive',reason:attack}}})];
  const html=ui.automaticPanel();assert.ok(!html.includes('<script>'));assert.ok(!html.includes('<img src=x'));assert.match(html,/&lt;script&gt;/);
});

test('batch cancellation waits for acknowledgement, avoids concurrent requests and retains the durable stop flag',async()=>{
  let requests=0,acknowledge;
  const ui=view({AbortSignal,fetch:async(path,options)=>{
    if(path.endsWith('/automatic-reproductions/cancel')){requests++;assert.equal(options.body,'{}');return new Promise(resolve=>{acknowledge=()=>resolve({ok:true,status:200,json:async()=>({cancellation_id:'stop-id',run_id:'run',status:'cancelling',reused:false})});});}
    throw new Error('Refresh unavailable for this test');
  }}),report=connectReview(ui);report.run.config.automatic_reproduction_policy={enabled:true,max_cases:2,max_actions:12};report.automatic_reproductions=[automaticTask()];
  const first=ui.cancelAutomatic('run');await ui.cancelAutomatic('run');assert.equal(requests,1);assert.equal(report.run.auto_reproduction_cancel_id,undefined);assert.match(ui.automaticPanel(),/Stopping automatic checks…/);
  acknowledge();await first;assert.equal(report.run.auto_reproduction_cancel_id,'stop-id');assert.equal(ui.state.cancelling.size,0);assert.match(ui.automaticPanel(),/data-id="run" disabled/);assert.match(ui.automaticPanel(),/model calls already sent may still finish/);
});
// Chrome fires a focused field's pending change event while innerHTML replaces it. These tests stand in for that browser behavior.
function liveRoot(onWrite=()=>{}){
  const listeners={},node={writes:0,classList:{add(){},remove(){}},querySelectorAll(){return[];},addEventListener(type,listener){(listeners[type]??=[]).push(listener);},
    get innerHTML(){return '';},set innerHTML(html){node.writes++;onWrite();}};
  return {node,dispatch(type,target){for(const listener of listeners[type]||[])listener({target});}};
}
test('a render requested while the page is being replaced waits for that pass instead of nesting',()=>{
  let depth=0,ui;
  const {node}=liveRoot(()=>{depth++;assert.equal(depth,1,'innerHTML was replaced re-entrantly');if(node.writes===1)ui.render();depth--;});
  ui=view({document:{querySelector(){return node;},addEventListener(){}}});
  ui.state.connected=true;ui.render();
  assert.equal(node.writes,2);
});
test('typing a target URL never redraws the launch form and keeps a saved session for the same site',()=>{
  const {node,dispatch}=liveRoot(),select={innerHTML:''};
  const ui=view({document:{querySelector(){return node;},getElementById(id){return id==='app-session'?select:null;},addEventListener(){}}});
  ui.state.connected=true;
  ui.state.access={requests:[],sessions:[{session_id:'saved',origin:'https://example.com',created_at:'2026-10-30T08:00:00Z',expires_at:'2099-01-01T00:00:00Z',execution_mode:'live'}]};
  const type=value=>{const target={id:'target-url',value,dataset:{}};dispatch('input',target);dispatch('change',target);};
  type('https://example.com/');
  assert.match(select.innerHTML,/value="saved"/);
  ui.state.sessionId='saved';type('https://example.com/checkout');
  assert.equal(ui.state.sessionId,'saved');
  type('https://other.example/');
  assert.equal(ui.state.sessionId,'');
  assert.doesNotMatch(select.innerHTML,/value="saved"/);
  assert.equal(ui.state.url,'https://other.example/');
  assert.equal(node.writes,0);
});
test('a pasted bare host becomes a launchable address and malformed input is explained instead of submitted',()=>{
  const ui=view();
  assert.equal(ui.normalizeTargetUrl('  app.acme.dev/login '),'https://app.acme.dev/login');
  assert.equal(ui.normalizeTargetUrl('localhost:3000'),'http://localhost:3000');
  assert.equal(ui.normalizeTargetUrl('http://staging.acme.dev'),'http://staging.acme.dev');
  assert.equal(ui.explorationRequest(new Map([['url','acme.dev']])).target_url,'https://acme.dev');
  for(const url of ['https://acme.dev/a?b=c','http://localhost:3000','http://[::1]:8080/'])assert.equal(ui.launchUrlError(url),'',url);
  assert.match(ui.launchUrlError(''),/Paste the address/);
  for(const url of [ui.normalizeTargetUrl('not a url'),'ftp://acme.dev','https://exa mple.com','javascript:alert(1)'])assert.match(ui.launchUrlError(url),/web address/,url);
  ui.state.launchError='Paste the address of the app you want to test.';
  assert.match(ui.home(),/role="alert"[^>]*>.*Paste the address/);assert.match(ui.home(),/aria-invalid="true"/);
});
test('the run heading says whether earlier runs guided it and names reopened remembered pages',()=>{
  const ui=view(),report=connectReview(ui);
  report.run.config.app_memory={version:'app-memory-v1',enabled:false,scopes:[]};assert.match(ui.runView(),/· Fresh exploration/);
  report.run.config.app_memory={version:'app-memory-v1',enabled:true,scopes:[{prior_runs:0}]};assert.match(ui.runView(),/· First remembered run/);
  report.run.config.app_memory={version:'app-memory-v1',enabled:true,scopes:[{prior_runs:2}]};assert.match(ui.runView(),/· Guided by 2 earlier runs/);
  delete report.run.config.app_memory;assert.doesNotMatch(ui.runView(),/earlier run|Fresh exploration/,'Runs recorded before memory show no label.');
  report.actions[0].spec={...report.actions[0].spec,command:{type:'navigate',url:'https://app.test/products'},exploration:{purpose:'resume'}};
  assert.match(ui.runView(),/Open remembered page/);
});

test('runs show input, output and total tokens with a cost estimated from model prices',()=>{
  const ui=view(),attack='<b>x</b>';
  const usage={attempts:3,known_input_tokens:1000300,known_output_tokens:250040,known_total_tokens:1250340,incomplete_usage_attempts:0,pending_requests:0,by_model:[
    {provider:'meta',model:'muse-spark-1.3',attempts:2,known_input_tokens:1000000,known_output_tokens:250000,known_total_tokens:1250000,incomplete_usage_attempts:0,provider_reported_cost_usd:null,unpriced_attempts:2},
    {provider:'openrouter',model:attack,attempts:1,known_input_tokens:300,known_output_tokens:40,known_total_tokens:340,incomplete_usage_attempts:0,provider_reported_cost_usd:null,unpriced_attempts:1}]};
  ui.state.settings={savedModels:[{provider:'meta',model:'muse-spark-1.3',label:'Muse Spark',inputUsdPerMillion:0.5,outputUsdPerMillion:2}]};
  let html=ui.costStat(usage);assert.match(html,/≥ \$1\.00/);assert.match(html,/No price for &lt;b&gt;x&lt;\/b&gt;\. Add one in Settings → Models\./);
  html=ui.usagePanel(usage);
  assert.match(html,/Muse Spark[\s\S]*Meta AI · muse-spark-1\.3[\s\S]*1,000,000[\s\S]*250,000[\s\S]*1,250,000[\s\S]*\$0\.50 in · \$2\.00 out per 1M tokens[\s\S]*Your price[\s\S]*\$1\.00/);
  assert.doesNotMatch(html,/<b>x<\/b>/);assert.match(html,/No price/);
  assert.match(html,/All models<\/th><td>3<\/td><td>1,000,300<\/td><td>250,040<\/td><td>1,250,340<\/td>/);
  ui.state.settings.savedModels.push({provider:'openrouter',model:attack,inputUsdPerMillion:0,outputUsdPerMillion:0});
  assert.match(ui.costStat(usage),/\$1\.00<\/div>[\s\S]*From your model prices/);
  assert.equal(ui.usagePanel({attempts:0,by_model:[]}),'','No calls, no usage table.');
  const row=ui.runUsage(usage);assert.match(row,/1,250,340/);assert.match(row,/1,000,300 in · 250,040 out/);assert.match(row,/\$1\.00 estimated/);
  assert.match(ui.runUsage({attempts:0}),/No model calls/);assert.match(ui.runUsage(undefined),/—/);
  ui.state.runs=[{run_id:'11111111-1111-4111-8111-111111111111',target_url:'https://a.test',lifecycle:'completed',config:{},model_usage:usage,summary:{actions:3}}];
  ui.state.websitePage='tests';assert.match(ui.home(),/<th>Model usage<\/th>[\s\S]*1,250,340/);
});
