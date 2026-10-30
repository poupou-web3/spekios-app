import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, hash } from '../src/store.js';
import { explore, reproduce } from '../src/explorer.js';
import { ModelClient } from '../src/model-client.js';
import { explorationFixture } from '../src/exploration-fixture.js';
import { parsePlan, stateFingerprint } from '../src/exploration-policy.js';
import { controlAction, commandKey } from '../src/interaction-contract.js';
import type { Capture, ObservedControl } from '../src/contracts.js';
import { controlContext } from '../src/model-context.js';

const field: ObservedControl={control_id:'a'.repeat(24),role:'textbox',name:'Query',href:null,disabled:false,ambiguous:false,submits_form:false,input_type:'text',max_length:12};
test('interaction proposals enforce exact types, bounded text and observed options',()=>{
  assert.deepEqual(controlAction(field,{type:'fill',value:''}),{type:'fill',value:''});
  for(const action of [{type:'click'},{type:'fill',value:'longer than twelve'},{type:'fill',value:'submit\n'}, {type:'fill',value:'test',selector:'#other'},{type:'press',key:'Enter'}])assert.throws(()=>controlAction(field,action));
  for(const status of [{sensitive:true},{read_only:true},{disabled:true},{occluded:true}])assert.throws(()=>controlAction({...field,...status},{type:'fill',value:'sample'}));
  const select={...field,role:'combobox' as const,options:[{value:'books',label:'Books',disabled:false},{value:'locked',label:'Locked',disabled:true}]};
  assert.equal(controlAction(select,{type:'select',value:'books'}).type,'select');
  for(const value of ['invented','locked'])assert.throws(()=>controlAction(select,{type:'select',value}));
  assert.throws(()=>controlAction({...select,options:[...select.options,select.options[0]]},{type:'select',value:'books'}));
  assert.throws(()=>controlAction({...select,options:[{value:'billing',label:'Pay now',disabled:false}]},{type:'select',value:'billing'}));
  assert.throws(()=>controlAction({...field,role:'radio'},{type:'set_checked',checked:false}));
  assert.throws(()=>controlAction({...field,role:'checkbox'},{type:'set_checked',checked:'true'}));
  const candidate={control_id:field.control_id,goal:'Filter results',expected_result:'Query changes',likelihood:.8,action:{type:'fill',value:'notebook'}};
  assert.equal(parsePlan({candidates:[candidate],stop_reason:null},[field]).candidates[0].action?.type,'fill');
  assert.throws(()=>parsePlan({candidates:[{...candidate,action:{type:'fill',value:'abc',execute_shell:'bad'}}],stop_reason:null},[field]));
  assert.notEqual(commandKey({type:'fill',control:field,value:'one'}),commandKey({type:'fill',control:field,value:'two'}));
});

test('field values and checkbox state participate in state identity, screenshot bytes and clocks do not',()=>{
  const captured=(control:ObservedControl,text='Ready',sha='same-screenshot',scroll={x:0,y:0})=>({sha256:sha,observation:{url:'http://app/',title:'App',text,text_truncated:false,viewport:{width:800,height:600},scroll,controls:[control]}} as Capture);
  assert.notEqual(stateFingerprint(captured({...field,value:'one'})),stateFingerprint(captured({...field,value:'two'})));
  assert.notEqual(stateFingerprint(captured({...field,role:'checkbox',checked:true})),stateFingerprint(captured({...field,role:'checkbox',checked:false})));
  assert.equal(stateFingerprint(captured(field,'Updated 2s ago','pixel-a')),stateFingerprint(captured(field,'Updated 5 minutes ago','pixel-b')));
  assert.equal(stateFingerprint(captured(field,'Ready', 'pixel-a', {x:0,y:0})),stateFingerprint(captured(field,'Ready', 'pixel-b', {x:0,y:3})));
  assert.notEqual(stateFingerprint(captured(field,'Ready')),stateFingerprint(captured(field,'Saved')));
  assert.notEqual(stateFingerprint(captured(field,'Ready', 'pixel-a', {x:0,y:0})),stateFingerprint(captured(field,'Ready', 'pixel-a', {x:0,y:40})));
  assert.equal(stateFingerprint(captured(field)),stateFingerprint(captured({...field,rect:{x:4,y:8,width:20,height:10}})));
});

test('large forms use a bounded prompt projection while retaining exact option values and full observations',()=>{
  const controls=Array.from({length:40},(_,index)=>({...field,control_id:String(index),role:'combobox' as const,
    options:Array.from({length:20},(_,i)=>({value:`${i}-`+'v'.repeat(190),label:'Label '.repeat(20),disabled:false}))}));
  const original=JSON.stringify(controls),shown=controlContext(controls);
  assert.ok(Buffer.byteLength(JSON.stringify(shown.controls))<=10000);
  assert.ok(shown.controls.length>0 && shown.controls.length<40);
  assert.equal(shown.controls_truncated,true);
  for(const c of shown.controls){assert.equal(c.options_truncated,true);assert.deepEqual(c.options?.[0],controls[0].options[0]);}
  assert.equal(JSON.stringify(controls),original);
});

test('typed interactions retain independent evidence and reproduce their exact parameters',{
  skip:process.env.SCOUT_EXPLORER_INTEGRATION!=='1',timeout:180000,
},async t=>{
  const store=await new Store().open(),fixture=await explorationFixture();
  const client=new ModelClient({provider:'openrouter',model:'scout-interactions-fixture:free',freeOnly:true});
  assert.equal(await client.ready(),'protocol_fixture');
  const options={client,allowedOrigins:[fixture.url],maxActions:6};
  try{
    await t.test('search, select, checkbox and radio actions advance a filter flow and get checked',async()=>{
      const result=await explore(store,fixture.url+'/interactions',options);
      assert.equal(result.report.run.lifecycle,'completed',result.report.run.error);
      assert.deepEqual(result.report.actions.map(a=>a.spec.command.type),['navigate','fill','select','set_checked','set_checked','click']);
      assert.equal(result.report.run.config.replans,0,'Caret blinking must not create a stale input plan.');
      assert.equal(result.report.run.config.screenshot_caret,'hide');
      assert.equal(result.report.run.config.screenshot_animations,'disabled');
      assert.equal(result.report.run.config.reduced_motion,'reduce');
      assert.equal(result.report.run.config.capture_clock,'paused_during_capture');
      assert.equal(result.report.model_requests.length,12);
      assert.equal(result.report.graph.edges.length,6);
      for(const action of result.report.actions){
        assert.equal(action.assessment.verdict,'no_issue_observed');
        assert.deepEqual(action.assessment.evidence_capture_ids,[action.before_capture_id,action.after_capture_id]);
        assert.ok(action.comparison.counts.changed_pixels>0);
        assert.ok(result.report.model_requests.find(r=>r.request_id===action.spec.prediction.request_id)!.finished_at<=action.dispatched_at);
      }
      const observation=(index:number):Capture['observation']=>result.report.captures.find(c=>c.capture_id===result.report.actions[index].after_capture_id)!.observation;
      assert.equal(observation(1).controls?.find(c=>c.name==='Search items')?.value,'notebook');
      assert.equal(observation(2).controls?.find(c=>c.name==='Category')?.value,'books');
      assert.equal(observation(3).controls?.find(c=>c.name==='In stock only')?.checked,true);
      assert.equal(observation(4).controls?.find(c=>c.name==='Grid view')?.checked,true);
      for(const c of result.report.captures)assert.equal(hash(await store.captureBytes(c.capture_id)),c.sha256);
    });
    await t.test('a suspect after form edits replays the exact synthetic values in a fresh browser',async()=>{
      const source=await explore(store,fixture.url+'/interactions/broken',options);
      assert.equal(source.report.run.lifecycle,'completed',source.report.run.error);
      assert.equal(source.report.actions.at(-1)!.assessment.verdict,'suspect');
      const result=await reproduce(store,source.report.actions.at(-1)!.action_id,options);
      assert.equal(result.report.run.lifecycle,'completed',result.report.run.error);
      assert.equal(result.report.reproductions[0].result.outcome,'reproduced');
      assert.deepEqual(result.report.actions.map(a=>a.spec.command),source.report.actions.map(a=>a.spec.command));
      assert.equal(result.report.model_requests.length,6);
      assert.equal(result.report.captures.length,12);
    });
    await t.test('a control further down the page is observed, scrolled into view before acting and replayed exactly',async()=>{
      const source=await explore(store,fixture.url+'/scrolling/broken',{...options,maxActions:2});
      assert.equal(source.report.run.lifecycle,'completed',source.report.run.error);
      assert.deepEqual(source.report.actions.map(a=>a.spec.command.type),['navigate','click']);
      const initial=source.report.captures.find(c=>c.capture_id===source.report.actions[0].after_capture_id)!;
      const below=initial.observation.controls!.find((c:ObservedControl)=>c.name==='Reveal details')!;
      assert.equal(below.in_viewport,false);
      assert.equal(below.rect,undefined);
      assert.ok(below.page_y!>initial.observation.viewport.height);
      const click=source.report.actions[1];
      assert.equal(click.spec.command.control.in_viewport,false);
      const before=source.report.captures.find(c=>c.capture_id===click.before_capture_id)!;
      assert.ok(before.observation.scroll!.y>0);
      const shown=before.observation.controls!.find((c:ObservedControl)=>c.name==='Reveal details')!;
      assert.equal(shown.in_viewport,true);
      assert.equal(shown.occluded,false);
      const revealed=source.report.events.find(e=>e.event_type==='action.revealed'&&e.action_id===click.action_id)!;
      assert.equal(revealed.payload.from.y,0);
      assert.equal(revealed.payload.to.y,before.observation.scroll!.y);
      assert.equal(click.assessment.verdict,'suspect');
      const result=await reproduce(store,click.action_id,options);
      assert.equal(result.report.run.lifecycle,'completed',result.report.run.error);
      assert.equal(result.report.reproductions[0].result.outcome,'reproduced');
      assert.deepEqual(result.report.actions.map(a=>a.spec.command),source.report.actions.map(a=>a.spec.command));
      assert.ok(result.report.events.some(e=>e.event_type==='action.revealed'));
    });
    await t.test('an explicit page scroll still reaches a lower control and survives exact replay',async()=>{
      const source=await explore(store,fixture.url+'/scrolling/manual/broken',{...options,maxActions:3});
      assert.equal(source.report.run.lifecycle,'completed',source.report.run.error);
      assert.deepEqual(source.report.actions.map(a=>a.spec.command.type),['navigate','scroll','click']);
      const scrolled=source.report.captures.find(c=>c.capture_id===source.report.actions[1].after_capture_id)!;
      assert.ok(scrolled.observation.scroll!.y>0);
      assert.equal(scrolled.observation.controls!.find((c:ObservedControl)=>c.name==='Reveal details')!.in_viewport,true);
      assert.equal(source.report.actions[1].assessment.verdict,'no_issue_observed');
      assert.ok(!source.report.events.some(e=>e.event_type==='action.revealed'),'A control already in view needs no reveal.');
      const result=await reproduce(store,source.report.actions[2].action_id,options);
      assert.equal(result.report.run.lifecycle,'completed',result.report.run.error);
      assert.equal(result.report.reproductions[0].result.outcome,'reproduced');
      assert.deepEqual(result.report.actions[1].spec.command,source.report.actions[1].spec.command);
    });
    await t.test('a lower control that turns out to be covered is skipped without dispatch',async()=>{
      const result=await explore(store,fixture.url+'/scrolling/covered',{...options,maxActions:2});
      assert.equal(result.report.run.lifecycle,'completed',result.report.run.error);
      const skipped=result.report.actions[1];
      assert.equal(skipped.state,'skipped');
      assert.equal(skipped.dispatched_at,null);
      assert.equal(skipped.assessment.method,'reveal-guard');
      assert.ok(skipped.before_capture_id);
      assert.ok(result.report.events.some(e=>e.event_type==='exploration.reveal_failed'&&e.action_id===skipped.action_id));
      const blocked=result.report.graph.frontier.filter((f:any)=>f.control.name==='Reveal details'&&f.status==='blocked');
      assert.ok(blocked.some((f:any)=>f.reason==='unavailable_after_reveal'));
      assert.equal(result.report.run.config.reveal_failures,1);
      assert.ok(result.report.actions.slice(2).every(a=>a.spec.command.control?.name!=='Reveal details'));
      assert.ok(!fixture.requests.includes('/forbidden-covered'));
    });
    await t.test('sensitive, read-only, covered and unsupported fields stay blocked while a checkbox can be unchecked',async()=>{
      const result=await explore(store,fixture.url+'/interaction-blocks',{...options,maxActions:3});
      assert.equal(result.report.run.lifecycle,'completed',result.report.run.error);
      assert.deepEqual(result.report.actions.map(a=>a.spec.command.type),['navigate','set_checked']);
      assert.equal(result.report.actions[1].spec.command.checked,false);
      assert.equal(result.report.actions[1].assessment.verdict,'no_issue_observed');
      const blocked=result.report.graph.frontier.filter((f:{status:string})=>f.status==='blocked');
      for(const name of ['Password','Email','Verification','Continue','Read only','Upload','Locked choice','Covered query'])assert.ok(blocked.some((f:{control:ObservedControl})=>f.control.name===name),name);
      for(const capture of result.report.captures)for(const c of capture.observation.controls??[])if(c.sensitive){assert.equal(c.value,undefined);assert.equal(c.checked,undefined);}
      assert.ok(!fixture.requests.some(path=>path.startsWith('/forbidden')));
    });
    await store.flush();
  }finally{await fixture.close();await store.close();}
});
