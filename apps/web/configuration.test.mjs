import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const defaults={provider:'openrouter',model:'openrouter/free',maxActions:6,viewportProfile:'desktop',freeOnly:true,autoReproduce:false,maxAutoReproductions:2,maxAutoReplayActions:12,allowedOrigins:['https://app.test']};
const response=(value,status=200)=>({ok:status<400,status,json:async()=>value});
function workspace(fetch=async()=>response({})){const handlers={},node={innerHTML:'',textContent:'',classList:{add(){},remove(){}},querySelectorAll(){return[];},addEventListener(type,fn){(handlers[type]??=[]).push(fn);}};
  let uuid=0;
  const sandbox={document:{querySelector(){return node;},getElementById(){return null;},addEventListener(){}},window:{addEventListener(){}},location:{hash:'#/operations'},sessionStorage:{getItem(){return null;},setItem(){},removeItem(){}},fetch,AbortSignal,URL,setInterval(){},setTimeout(){},clearTimeout(){},crypto:{randomUUID:()=>`00000000-0000-4000-8000-${String(++uuid).padStart(12,'0')}`}};
  vm.createContext(sandbox);vm.runInContext(readFileSync(new URL('./app.js',import.meta.url),'utf8')+'\nglobalThis.testing={state,configurationValues,configurationDraft,configurationError,updateConfiguration,rebaseConfiguration,applyConfiguration,configurationView,saveConfiguration,navigateAction};',sandbox);
  const ui=sandbox.testing;Object.assign(ui.state,{connected:true,developmentAccess:true,settings:{...defaults},settingsRevision:3,view:'operations',opsTab:'connections'});return {...ui,node,handlers};
}
const plain=value=>JSON.parse(JSON.stringify(value));
test('defaults validate the same supported models, limits and free-only restriction as the API',()=>{
  const ui=workspace(),values=ui.configurationValues();assert.equal(ui.configurationError(values),'');
  for(const patch of [{model:'x\n'},{model:'<script>'},{model:'x'.repeat(201)},{max_actions:0},{max_actions:2.5},{max_actions:null},{max_auto_reproductions:4},{max_auto_replay_actions:25},{viewport_profile:'watch'},{provider:'other'},{model:'paid/model'}])assert.ok(ui.configurationError({...values,...patch}),JSON.stringify(patch));
  assert.equal(ui.configurationError({...values,model:'vendor/model:free'}),'');
  assert.equal(ui.configurationError({...values,provider:'openai',model:'provider-model',free_only:false}),'');
});
test('changing providers never carries another provider model or free-only billing assumption',()=>{
  const ui=workspace();ui.updateConfiguration('provider','openai');let d=ui.configurationDraft();assert.equal(d.values.model,'');assert.equal(d.values.free_only,false);
  ui.updateConfiguration('model','my-openai-model');ui.updateConfiguration('provider','anthropic');assert.equal(d.values.model,'');
  ui.updateConfiguration('provider','openai');assert.equal(d.values.model,'my-openai-model');
  ui.updateConfiguration('provider','openrouter');assert.equal(d.values.model,'openrouter/free');
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
  assert.deepEqual(Object.keys(plain(ui.configurationValues())).sort(),['auto_reproduce','free_only','max_actions','max_auto_replay_actions','max_auto_reproductions','model','provider','viewport_profile'].sort());
});
test('previous and next follow the visible list, preserve comparison, and reject stale targets',()=>{
  const ui=workspace();ui.state.report={run:{},actions:[{action_id:'one'},{action_id:'two'},{action_id:'three'}],events:[]};ui.state.actionId='one';ui.state.image='compare';ui.state.frameId='old';
  assert.equal(ui.navigateAction(1,'three'),false);assert.equal(ui.navigateAction(-1,''),false);assert.equal(ui.navigateAction(1,'two'),true);assert.equal(ui.state.actionId,'two');assert.equal(ui.state.image,'compare');assert.equal(ui.state.frameId,null);
  ui.state.image='frame';assert.equal(ui.navigateAction(-1,'one'),true);assert.equal(ui.state.image,'after');
});
