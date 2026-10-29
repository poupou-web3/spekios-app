import {uiSource} from './test-support/source.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const response=(value,status=200)=>({ok:status<400,status,json:async()=>value});
const report=id=>({run:{run_id:id,lifecycle:'active',config:{runtime_version:'explorer-v1',replay_of:null}},steering:{run_id:id,revision:0,messages:[]}});
const item=(revision,status='pending',focus='Search')=>({steering_id:'id-'+revision,revision,status,focus});
function workspace(fetch=async()=>response({}),storage=new Map()){
  const node={innerHTML:'',textContent:'',classList:{add(){},remove(){}},querySelectorAll(){return[];},addEventListener(){}};
  const sandbox={document:{querySelector(){return node;},getElementById(){return null;},addEventListener(){}},window:{addEventListener(){}},location:{hash:'#/operations'},
    sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},fetch,AbortSignal,URL,setInterval(){},setTimeout(){},clearTimeout(){},crypto:{randomUUID:()=>crypto.randomUUID()}};
  vm.createContext(sandbox);vm.runInContext(uiSource('app.js')+'\nglobalThis.testing={state,steeringDrafts,steeringDraft,updateSteeringFocus,steeringPanel,submitSteering,mergeSteering};',sandbox);
  const ui=sandbox.testing;Object.assign(ui.state,{connected:true,developmentAccess:true,runId:'one',report:report('one'),view:'operations',opsTab:'connections'});return{...ui,storage,node};
}
const plain=value=>JSON.parse(JSON.stringify(value));
test('focus is escaped and acknowledgement does not claim coverage or retroactive assessment',()=>{
  const ui=workspace();ui.updateSteeringFocus('<script>focus</script>');let html=ui.steeringPanel();
  assert.match(html,/&lt;script&gt;focus/);assert.doesNotMatch(html,/<script>/);assert.match(html,/after the current action is assessed/);
  ui.state.report.steering={revision:1,messages:[item(1,'applied')]};html=ui.steeringPanel();assert.match(html,/Applied to planning/);
  ui.state.report.run.config.replay_of={};assert.equal(ui.steeringPanel(),'');
});
test('unknown admission retries exactly the same command even after a newer revision is polled',async()=>{
  const bodies=[];let fail=true;const ui=workspace(async(path,options)=>{bodies.push(options.body);if(fail)throw new Error('Network interrupted');const command=JSON.parse(options.body);return response({revision:1,messages:[{...command,revision:1,status:'superseded'}],submission:{status:'superseded'}});});
  ui.updateSteeringFocus('Search');await ui.submitSteering();const command=plain(ui.steeringDraft().command);assert.ok(command.steering_id);
  ui.state.report.steering={revision:2,messages:[item(1,'superseded'),item(2)]};
  assert.equal(ui.updateSteeringFocus('Different'),false);fail=false;await ui.submitSteering();
  assert.equal(bodies[0],bodies[1]);assert.equal(ui.state.report.steering.revision,2);assert.equal(ui.steeringDraft().command,null);assert.equal(ui.storage.has('scout.pending-focus.one'),false);
});
test('an uncertain command survives reload and each run retains its own retry',async()=>{
  const storage=new Map(),ui=workspace(async()=>{throw new Error('timeout');},storage);
  ui.updateSteeringFocus('Search');await ui.submitSteering();const command=plain(ui.steeringDraft().command);
  ui.state.runId='two';ui.state.report=report('two');ui.updateSteeringFocus('Filters');await ui.submitSteering();
  assert.equal(storage.size,2);const fresh=workspace(undefined,storage);assert.deepEqual(plain(fresh.steeringDraft().command),command);
});
test('duplicate clicks are ignored and a late receipt never overwrites edits on another run',async()=>{
  let complete,started;const ready=new Promise(r=>started=r),calls=[];
  const ui=workspace(async(path,options)=>{calls.push(path);started();return new Promise(r=>complete=r);});
  ui.updateSteeringFocus('Search');const first=ui.submitSteering();await ready;await ui.submitSteering();assert.equal(calls.length,1);assert.equal(ui.updateSteeringFocus('In flight'),false);
  ui.state.runId='two';ui.state.report=report('two');ui.updateSteeringFocus('Second run');
  complete(response({revision:1,messages:[item(1)],submission:{status:'pending'}}));await first;
  assert.equal(ui.state.report.steering.revision,0);assert.equal(ui.steeringDraft().focus,'Second run');
});
test('revision conflicts refresh history and keep edits until explicitly rebased',async()=>{
  let writes=0;const ui=workspace(async(path,options)=>options.method==='POST'?(writes++,response({error:'steering_revision_conflict'},409)):response({revision:2,messages:[item(2,'pending','Other focus')]}));
  ui.updateSteeringFocus('My focus');await ui.submitSteering();assert.equal(ui.steeringDraft().focus,'My focus');assert.equal(ui.steeringDraft().revision,0);
  assert.match(ui.steeringPanel(),/Keep my edits/);await ui.submitSteering();assert.equal(writes,1);
});
test('older pending snapshots cannot roll back an applied acknowledgement',()=>{
  const ui=workspace(),old={revision:1,messages:[item(1,'pending')]},fresh={revision:1,messages:[item(1,'applied')]};
  assert.equal(ui.mergeSteering(old,fresh).messages[0].status,'applied');assert.equal(ui.mergeSteering(old,{revision:2,messages:[]}).revision,2);
});
test('a late body from a previous workspace cannot update the current focus',async()=>{
  let complete,started;const ready=new Promise(r=>started=r),ui=workspace(async()=>({ok:true,status:200,json:async()=>{started();return new Promise(r=>complete=r);}}));
  ui.updateSteeringFocus('Search');const sending=ui.submitSteering();await ready;ui.state.token='new-credential';
  complete({revision:1,messages:[item(1)],submission:{status:'pending'}});await sending;assert.equal(ui.state.report.steering.revision,0);
});

test('a saved receipt cannot keep claiming the worker is waiting after acknowledgement changes',async()=>{
  const ui=workspace(async()=>response({revision:1,messages:[item(1)],submission:{status:'pending'}}));
  ui.updateSteeringFocus('Search');await ui.submitSteering();
  ui.state.report.steering={revision:1,messages:[item(1,'applied')]};
  assert.match(ui.steeringPanel(),/Applied to planning/);assert.doesNotMatch(ui.steeringPanel(),/Focus saved. Waiting for the next planning decision/);
});
