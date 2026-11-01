import {appSource} from './support.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const defaults={provider:'openrouter',model:'openrouter/free',maxActions:6,viewportProfile:'desktop',freeOnly:true,autoReproduce:false,maxAutoReproductions:2,maxAutoReplayActions:12,allowedOrigins:['https://app.test']};
const response=(value,status=200)=>({ok:status<400,status,json:async()=>value});
function workspace(fetch=async()=>response({})){const handlers={},node={innerHTML:'',textContent:'',classList:{add(){},remove(){}},querySelectorAll(){return[];},addEventListener(type,fn){(handlers[type]??=[]).push(fn);}};
  let uuid=0;
  const sandbox={document:{querySelector(){return node;},getElementById(){return null;},addEventListener(){}},window:{addEventListener(){}},location:{hash:'#/settings'},sessionStorage:{getItem(){return null;},setItem(){},removeItem(){}},fetch,AbortSignal,URL,setInterval(){},setTimeout(){},clearTimeout(){},crypto:{randomUUID:()=>`00000000-0000-4000-8000-${String(++uuid).padStart(12,'0')}`}};
  vm.createContext(sandbox);vm.runInContext(appSource('main.js')+'\nglobalThis.testing={state,configurationValues,configurationDraft,configurationError,configurationIssue,updateConfiguration,updateNewModel,addSavedModel,removeSavedModel,changedSections,rebaseConfiguration,applyConfiguration,configurationView,settingsView,saveConfiguration,navigateAction,memoryPanel};',sandbox);
  const ui=sandbox.testing;Object.assign(ui.state,{connected:true,developmentAccess:true,settings:{...defaults},settingsRevision:3,view:'settings'});return {...ui,node,handlers};
}
const plain=value=>JSON.parse(JSON.stringify(value));
test('defaults validate the same supported models, limits and free-only restriction as the API',()=>{
  const ui=workspace(),values=ui.configurationValues();assert.equal(ui.configurationError(values),'');
  for(const patch of [{model:'x\n'},{model:'<script>'},{model:'x'.repeat(201)},{max_actions:0},{max_actions:2.5},{max_actions:10001},{max_minutes:0},{max_minutes:10081},{max_tokens:999},{max_cost_usd:0},{stop_after_idle_actions:4},{max_auto_reproductions:4},{max_auto_replay_actions:101},{viewport_profile:'watch'},{provider:'other'},{model:'paid/model'}])assert.ok(ui.configurationError({...values,...patch}),JSON.stringify(patch));
  assert.equal(ui.configurationError({...values,model:'vendor/model:free'}),'');
  assert.equal(ui.configurationError({...values,max_actions:50,max_auto_replay_actions:100}),'');
  assert.equal(ui.configurationError({...values,max_actions:null,max_minutes:null,max_tokens:null,max_cost_usd:null,stop_after_idle_actions:null}),'','Every limit can be empty: no limit.');
  assert.equal(ui.configurationError({...values,max_actions:10000,max_minutes:10080,max_tokens:1000000000,max_cost_usd:2.5}),'');
  assert.equal(ui.configurationError({...values,max_cost_usd:'1.50'}),'');
  assert.match(ui.configurationError({...values,max_cost_usd:'0.0'}),/Maximum reported cost/);
  assert.equal(ui.configurationError({...values,provider:'openai',model:'provider-model',free_only:false}),'');
  assert.equal(ui.configurationError({...values,provider:'meta',model:'muse-wonder-1.0',free_only:false}),'');
  for(const exploration_strategy of [{breadth:50,depth:30,rewalk:30,adaptive:true},{breadth:0,depth:0,rewalk:100,adaptive:true},{breadth:50.5,depth:29.5,rewalk:20,adaptive:true},{breadth:null,depth:80,rewalk:20,adaptive:true},{breadth:-5,depth:85,rewalk:20,adaptive:true}])
    assert.ok(ui.configurationError({...values,exploration_strategy}),JSON.stringify(exploration_strategy));
  assert.equal(ui.configurationError({...values,exploration_strategy:{breadth:0,depth:100,rewalk:0,adaptive:false}}),'');
});
test('models are picked from a saved list that holds several models per provider, such as two Meta models',async()=>{
  let sent;const ui=workspace(async(path,options)=>{sent=JSON.parse(options.body);return response({revision:4,settings:{...defaults}},201);});
  ui.state.providers={providers:[{provider:'openrouter',configured:true},{provider:'meta',configured:true},{provider:'openai',configured:false}]};
  assert.deepEqual(plain(ui.configurationValues().saved_models),[{provider:'openrouter',model:'openrouter/free',label:''}],'The model in use is always listed.');
  assert.equal(ui.configurationDraft().dirty,false);
  const add=(provider,model,label='')=>{ui.updateNewModel('provider',provider);ui.updateNewModel('model',model);ui.updateNewModel('label',label);return ui.addSavedModel();};
  assert.equal(add('meta',' muse-wonder-1.0 ','Muse Wonder'),true);assert.equal(add('meta','muse-spark-1.3','Muse Spark'),true);
  const d=ui.configurationDraft();assert.equal(d.dirty,true);assert.deepEqual(plain(ui.changedSections()),['models']);
  assert.deepEqual(plain(d.values.saved_models.filter(m=>m.provider==='meta').map(m=>m.model)),['muse-wonder-1.0','muse-spark-1.3']);
  assert.match(d.added,/Added Muse Spark/);assert.deepEqual(plain(d.adding),{provider:'meta',model:'',label:''},'The fields clear and keep the provider for the next model.');
  for(const [provider,model,label,message] of [['meta','muse-spark-1.3','',/already in your list/],['meta','a b','',/letters, numbers/],['meta','','',/model ID/],['meta','ok','x'.repeat(61),/60 characters/]]){
    assert.equal(add(provider,model,label),false);assert.match(d.addError,message);
  }
  assert.equal(add('openai','muse-spark-1.3'),true,'Another provider can use the same model ID.');
  ui.updateNewModel('model','');
  assert.equal(ui.updateConfiguration('exploration_model','meta|unlisted'),false,'Only listed models can be chosen.');
  ui.updateConfiguration('exploration_model','meta|muse-spark-1.3');ui.updateConfiguration('navigation_choice','meta|muse-wonder-1.0');
  assert.equal(d.values.provider,'meta');assert.equal(d.values.model,'muse-spark-1.3');assert.equal(d.values.free_only,false,'Free-only belongs to OpenRouter.');
  assert.deepEqual(plain(d.values.navigation_model),{provider:'meta',model:'muse-wonder-1.0'});
  const html=ui.configurationView('models');
  assert.match(html,/<optgroup label="Meta AI">[\s\S]*Muse Wonder \(muse-wonder-1\.0\)[\s\S]*Muse Spark \(muse-spark-1\.3\)/);
  assert.match(html,/<optgroup label="OpenAI · not configured on this server">/);
  assert.match(html,/value="meta\|muse-spark-1\.3" selected/);assert.match(html,/Exploration<\/span>/);assert.match(html,/Navigation<\/span>/);
  const index=model=>d.values.saved_models.findIndex(m=>m.model===model);
  assert.equal(ui.removeSavedModel(index('muse-spark-1.3')),false,'A model in use stays listed.');
  assert.equal(ui.removeSavedModel(index('openrouter/free')),true);assert.equal(index('openrouter/free'),-1);
  assert.equal(ui.configurationError(d.values),'');
  await ui.saveConfiguration();
  assert.deepEqual(sent.saved_models,[{provider:'meta',model:'muse-wonder-1.0',label:'Muse Wonder'},{provider:'meta',model:'muse-spark-1.3',label:'Muse Spark'},{provider:'openai',model:'muse-spark-1.3'}]);
  assert.equal(sent.provider,'meta');assert.equal(sent.model,'muse-spark-1.3');assert.deepEqual(sent.navigation_model,{provider:'meta',model:'muse-wonder-1.0'});
});
test('settings open one section at a time, mark unsaved sections and link errors to the section that needs a fix',()=>{
  const ui=workspace();
  for(const [section,text] of [['models',/Your models/],['exploration',/Exploration strategy/],['limits',/Run limits/],['data',/App memory/],['appearance',/Theme/]]){
    ui.state.settingsSection=section;const html=ui.settingsView();
    assert.match(html,new RegExp(`href="#/settings/${section}" aria-current="page"`));assert.match(html,text);
  }
  ui.state.settingsSection='nowhere';assert.match(ui.settingsView(),/href="#\/settings\/models" aria-current="page"/,'Unknown sections show the first.');
  ui.state.settingsSection='appearance';assert.doesNotMatch(ui.settingsView(),/Save defaults/,'Appearance has nothing to save until another section has edits.');
  ui.updateConfiguration('override.0.max_minutes',5);ui.updateConfiguration('max_tokens',5);
  assert.deepEqual(plain(ui.configurationIssue(ui.configurationDraft().values)),['limits','Maximum reported tokens must be empty (no limit) or a whole number from 1000 to 1000000000.']);
  ui.state.settingsSection='models';const html=ui.settingsView();
  assert.match(html,/Limits<span class="settings-nav-mark error"/);assert.match(html,/Unsaved changes in <a href="#\/settings\/limits">Limits<\/a>/);
  assert.match(html,/<a href="#\/settings\/limits">Limits<\/a>: Maximum reported tokens/);assert.match(html,/type="submit" class="button primary" disabled/);
  ui.state.settingsSection='appearance';assert.match(ui.settingsView(),/Save defaults/,'Unsaved edits stay visible from every section.');
});
test('typing a decimal keeps the unfinished text and saves a number',async()=>{
  const calls=[],ui=workspace(async(path,options)=>{calls.push(JSON.parse(options.body));return response({revision:4,settings:{...defaults,maxCostUsd:1.5}});});
  const input={type:'number',value:'0.0',validity:{badInput:false},dataset:{configurationField:'max_cost_usd'}};
  ui.handlers.input[0]({target:input});assert.equal(ui.configurationDraft().values.max_cost_usd,'0.0');assert.match(ui.configurationView('limits'),/value="0.0"/);
  input.validity={badInput:true};input.value='';const html=ui.node.innerHTML;ui.handlers.input[0]({target:input});
  assert.equal(ui.configurationDraft().values.max_cost_usd,'0.0');assert.equal(ui.node.innerHTML,html);
  input.validity={badInput:false};input.value='1.50';ui.handlers.input[0]({target:input});assert.equal(ui.configurationError(ui.configurationDraft().values),'');
  await ui.saveConfiguration();assert.equal(calls[0].max_cost_usd,1.5);
});
test('dirty drafts survive polling while clean defaults advance and stale responses cannot roll them back',()=>{
  const ui=workspace();ui.updateConfiguration('max_actions',9);const d=ui.configurationDraft();
  ui.applyConfiguration({revision:4,settings:{...defaults,maxActions:3}});assert.equal(ui.configurationDraft(),d);assert.equal(d.values.max_actions,9);assert.equal(d.revision,3);assert.match(ui.configurationView(),/Keep my edits on revision 4/);
  ui.applyConfiguration({revision:2,settings:{...defaults,maxActions:1}});assert.equal(ui.state.settings.maxActions,3);
  ui.rebaseConfiguration();assert.equal(d.revision,4);assert.equal(d.values.max_actions,9);assert.equal(d.dirty,true);
  ui.rebaseConfiguration(true);assert.equal(ui.configurationDraft().values.max_actions,3);assert.equal(ui.configurationDraft().dirty,false);
});
test('saving makes no inference and leaves admitted jobs unchanged',async()=>{
  const calls=[],ui=workspace(async(path,options)=>{calls.push({path,options});return response({revision:4,settings:{...defaults,maxActions:8}});});
  ui.state.jobs=[{job_id:'frozen',settings:{...defaults}}];const jobs=JSON.stringify(ui.state.jobs);ui.updateConfiguration('max_actions',8);await ui.saveConfiguration();
  const body=JSON.parse(calls[0].options.body);assert.equal(body.expected_revision,3);assert.equal(body.max_actions,8);assert.equal(body.free_only,true);assert.equal(Object.hasOwn(body,'allowedOrigins'),false);
  assert.ok(calls.every(c=>c.path==='/v1/exploration-settings'));assert.equal(JSON.stringify(ui.state.jobs),jobs);assert.equal(ui.state.settingsRevision,4);assert.equal(ui.configurationDraft().dirty,false);assert.match(ui.configurationView(),/Saved revision 4/);
});
test('ambiguous save retries retain identity even after polling sees a newer revision',async()=>{
  const bodies=[];let fail=true;const ui=workspace(async(path,options)=>{if(options.method==='POST'){bodies.push(options.body);if(fail)throw new Error('Timed out');return response({revision:4,settings:{...defaults,maxActions:8},reused:true});}return response({revision:5,settings:{...defaults,maxActions:10}});});
  ui.updateConfiguration('max_actions',8);await ui.saveConfiguration();assert.ok(ui.configurationDraft().requestId);
  ui.applyConfiguration({revision:5,settings:{...defaults,maxActions:10}});assert.match(ui.configurationView(),/Retry save/);
  fail=false;await ui.saveConfiguration();assert.equal(bodies.length,2);assert.equal(bodies[0],bodies[1]);assert.equal(ui.state.settingsRevision,5);assert.equal(ui.configurationDraft().values.max_actions,10);
});
test('duplicate save clicks produce one write and inputs remain frozen in flight',async()=>{
  let complete,started;const ready=new Promise(r=>started=r),calls=[];const ui=workspace(async(path,options)=>{calls.push(path);if(options.method==='POST'){started();return new Promise(r=>complete=r);}return response({revision:4,settings:{...defaults,maxActions:8}});});
  ui.updateConfiguration('max_actions',8);const saving=ui.saveConfiguration();await ready;await ui.saveConfiguration();assert.equal(ui.updateConfiguration('max_actions',7),false);assert.equal(calls.length,1);
  complete(response({revision:4,settings:{...defaults,maxActions:8}}));await saving;assert.equal(ui.configurationDraft().dirty,false);
});
test('revision conflicts retain edits, refresh saved values, and require an explicit rebase',async()=>{
  let writes=0;const ui=workspace(async(path,options)=>options.method==='POST'?(writes++,response({error:'revision_conflict'},409)):response({revision:4,settings:{...defaults,maxActions:2}}));
  ui.updateConfiguration('max_actions',8);await ui.saveConfiguration();const d=ui.configurationDraft();assert.equal(d.values.max_actions,8);assert.equal(d.revision,3);assert.equal(ui.state.settingsRevision,4);assert.equal(d.requestId,null);
  await ui.saveConfiguration();assert.equal(writes,1);ui.rebaseConfiguration();assert.equal(d.revision,4);assert.equal(d.values.max_actions,8);
});
test('late tokenless save cannot reconnect or alter a disconnected workspace',async()=>{
  let complete,started;const ready=new Promise(r=>started=r),ui=workspace(async()=>{started();return new Promise(r=>complete=r);});ui.updateConfiguration('max_actions',8);const saving=ui.saveConfiguration();await ready;
  ui.state.developmentAccess=false;ui.state.connected=false;complete(response({revision:4,settings:{...defaults,maxActions:8}}));await saving;assert.equal(ui.state.connected,false);assert.equal(ui.state.settingsRevision,3);
});
test('an old acknowledgement cannot discard a new draft after reconnecting with the same access mode',async()=>{
  let complete,started;const ready=new Promise(r=>started=r),ui=workspace(async()=>{started();return new Promise(r=>complete=r);});ui.updateConfiguration('max_actions',8);const saving=ui.saveConfiguration();await ready;
  ui.state.configurationDraft=null;ui.state.developmentAccess=false;ui.state.connected=false;
  ui.state.developmentAccess=true;ui.state.connected=true;ui.updateConfiguration('max_actions',9);const newDraft=ui.configurationDraft();
  complete(response({revision:4,settings:{...defaults,maxActions:8}}));await saving;
  assert.equal(ui.configurationDraft(),newDraft);assert.equal(newDraft.dirty,true);assert.equal(newDraft.values.max_actions,9);
});
test('configuration text is escaped, exposes no secret input and clearly separates immutable environment policy',()=>{
  const ui=workspace();ui.updateConfiguration('model','<script>bad()</script>');const html=ui.configurationView();assert.doesNotMatch(html,/<script>|type="password"/);assert.match(html,/&lt;script&gt;/);assert.match(html,/Queued and running jobs keep their original settings/);assert.match(html,/Saving does not call a model/);
  assert.deepEqual(Object.keys(plain(ui.configurationValues())).sort(),['app_memory','auto_reproduce','exploration_strategy','free_only','limit_overrides','navigation_model','reuse_rankings','max_actions','max_auto_replay_actions','max_auto_reproductions','max_cost_usd','max_minutes','max_tokens','model','provider','saved_models','stop_after_idle_actions','viewport_profile'].sort());
});
test('previous and next follow the visible list, preserve comparison, and reject stale targets',()=>{
  const ui=workspace();ui.state.report={run:{},actions:[{action_id:'one'},{action_id:'two'},{action_id:'three'}],events:[]};ui.state.actionId='one';ui.state.image='compare';ui.state.frameId='old';
  assert.equal(ui.navigateAction(1,'three'),false);assert.equal(ui.navigateAction(-1,''),false);assert.equal(ui.navigateAction(1,'two'),true);assert.equal(ui.state.actionId,'two');assert.equal(ui.state.image,'compare');assert.equal(ui.state.frameId,null);
  ui.state.image='frame';assert.equal(ui.navigateAction(-1,'one'),true);assert.equal(ui.state.image,'after');
});
test('app memory is a saved default that can be turned off, and remembered scopes can be forgotten',async()=>{
  const ui=workspace();assert.equal(ui.configurationValues().app_memory,true,'Memory follows the server default when unset.');
  ui.applyConfiguration({revision:4,settings:{...defaults,appMemory:false}});assert.equal(ui.configurationValues().app_memory,false);
  ui.updateConfiguration('app_memory',true);assert.equal(ui.configurationDraft().values.app_memory,true);assert.match(ui.configurationView('data'),/Remember explored pages and controls across runs/);
  assert.match(ui.memoryPanel(),/Loading app memory/);
  ui.state.memory={scopes:[]};assert.match(ui.memoryPanel(),/No app memory yet/);
  ui.state.memory={scopes:[{scope_id:'00000000-0000-4000-8000-000000000009',origin:'https://app.test/<x>',viewport_profile:'mobile',auth_scope:'signed_in',execution_mode:'live',runs:2,pages:3,tried_controls:4,untried_controls:5,updated_at:'2026-10-30T10:00:00Z',in_use:false},
    {scope_id:'00000000-0000-4000-8000-000000000010',origin:'https://busy.test',viewport_profile:'desktop',auth_scope:'public',execution_mode:'protocol_fixture',runs:1,pages:1,tried_controls:0,untried_controls:1,updated_at:'2026-10-30T10:00:00Z',in_use:true}]};
  const html=ui.memoryPanel();
  assert.match(html,/https:\/\/app.test\/&lt;x&gt;/);assert.doesNotMatch(html,/<x>/);
  assert.match(html,/mobile · signed in · 2 runs · 3 pages · 4 tried \/ 5 untried controls/);
  assert.match(html,/data-action="forget-memory"[^>]*data-id="00000000-0000-4000-8000-000000000009"/);
  assert.match(html,/Test data · desktop · public · 1 run ·/);
  assert.match(html,/In use by a running test/);assert.equal((html.match(/forget-memory/g)||[]).length,1,'A scope in use cannot be forgotten.');
  assert.match(html,/recorded runs and evidence stay/);
});

test('limits are empty (no limit) unless saved, and overrides for projects and models are validated and sent as rules',async()=>{
  let sent=null;const ui=workspace(async(path,options)=>{if(path==='/v1/exploration-settings'&&options?.method==='POST'){sent=JSON.parse(options.body);return response({revision:4,settings:{...defaults,maxActions:null}});}return response({revision:4,settings:defaults});});
  ui.applyConfiguration({revision:3,settings:{provider:'openrouter',model:'openrouter/free',freeOnly:true,viewportProfile:'desktop',maxAutoReproductions:2,maxAutoReplayActions:12}});
  const values=ui.configurationValues();assert.equal(values.max_actions,null);assert.equal(values.max_tokens,null);assert.equal(values.stop_after_idle_actions,50,'Idle stop follows the server default when unset.');
  assert.match(ui.configurationView('limits'),/Leave a limit empty for no limit/);
  const project='11111111-1111-4111-8111-111111111111';
  ui.applyConfiguration({revision:4,settings:{...defaults,maxActions:null,limitOverrides:[{projectId:project,limits:{maxActions:300,maxTokens:null}}]}});
  const loaded=ui.configurationValues().limit_overrides[0];assert.equal(loaded.project_id,project);assert.equal(loaded.max_actions,300);assert.equal(loaded.max_minutes,null);
  ui.updateConfiguration('max_tokens',200000);ui.updateConfiguration('override.0.max_minutes',45);
  const draft=ui.configurationDraft();assert.equal(draft.values.limit_overrides[0].max_minutes,45);assert.equal(ui.configurationError(draft.values),'');
  for(const [field,value,message] of [['override.0.project_id','not-a-uuid',/UUID/],['override.0.project_id','',/project ID, a provider or a model/]]){
    const before=draft.values.limit_overrides[0].project_id;ui.updateConfiguration(field,value);assert.match(ui.configurationError(draft.values),message);ui.updateConfiguration('override.0.project_id',before);
  }
  ui.updateConfiguration('override.0.model','openrouter/free');assert.equal(ui.configurationError(draft.values),'');
  await ui.saveConfiguration();
  assert.equal(sent.max_actions,null,'An empty limit is sent as null: no limit.');assert.equal(sent.max_tokens,200000);
  assert.deepEqual(sent.limit_overrides,[{project_id:project,model:'openrouter/free',limits:{max_actions:300,max_minutes:45}}],'Empty override fields inherit and are omitted.');
});
test('the exploration strategy split is a saved default with an adaptive switch',async()=>{
  let sent;const ui=workspace(async(url,options)=>{sent=JSON.parse(options.body);return response({revision:4,settings:{...defaults,explorationStrategy:{breadth:40,depth:40,rewalk:20,adaptive:false}}},201);});
  assert.deepEqual(plain(ui.configurationValues().exploration_strategy),{breadth:50,depth:30,rewalk:20,adaptive:true},'The default split applies when nothing is saved.');
  const html=ui.configurationView('exploration');assert.match(html,/Exploration strategy/);assert.match(html,/data-configuration-field="strategy.rewalk"/);assert.match(html,/Total 100% of 100%/);
  assert.equal(ui.updateConfiguration('strategy.order','bfs'),false,'Only the three shares and the switch exist.');
  ui.updateConfiguration('strategy.breadth',40);const draft=ui.configurationDraft();assert.match(ui.configurationError(draft.values),/add up to 100%/);
  ui.updateConfiguration('strategy.depth',40);ui.updateConfiguration('strategy.adaptive',false);assert.equal(ui.configurationError(draft.values),'');
  await ui.saveConfiguration();
  assert.deepEqual(sent.exploration_strategy,{breadth:40,depth:40,rewalk:20,adaptive:false});
});

test('ranking reuse and a navigation model are saved defaults; one model stays the default',async()=>{
  let sent;const ui=workspace(async(url,options)=>{sent=JSON.parse(options.body);return response({revision:4,settings:{...defaults,navigationModel:{provider:'openrouter',model:'vendor/lite:free'}}},201);});
  const values=ui.configurationValues();assert.equal(values.reuse_rankings,true);assert.deepEqual(plain(values.navigation_model),{provider:'',model:''});
  const html=ui.configurationView('models');assert.match(html,/Cost controls/);assert.match(html,/<option value="" selected>Same as exploration model<\/option>/);assert.match(html,/data-configuration-field="navigation_choice"/);
  for(const navigation_model of [{provider:'other',model:'x'},{provider:'openai',model:'a b'},{provider:'openrouter',model:'paid/model'}])
    assert.ok(ui.configurationError({...values,navigation_model}),JSON.stringify(navigation_model));
  assert.equal(ui.configurationError({...values,free_only:false,navigation_model:{provider:'anthropic',model:'small'}}),'');
  ui.updateConfiguration('navigation.provider','openrouter');ui.updateConfiguration('navigation.model',' vendor/lite:free ');ui.updateConfiguration('reuse_rankings',false);
  assert.equal(ui.updateConfiguration('navigation.tier','x'),false);
  assert.equal(ui.configurationError(ui.configurationDraft().values),'');
  await ui.saveConfiguration();
  assert.deepEqual(sent.navigation_model,{provider:'openrouter',model:'vendor/lite:free'});assert.equal(sent.reuse_rankings,false);
  ui.updateConfiguration('navigation.provider','');await ui.saveConfiguration();assert.equal(sent.navigation_model,null,'No provider sends null: one model.');
});
