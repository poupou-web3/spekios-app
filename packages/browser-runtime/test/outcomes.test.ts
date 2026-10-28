import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { Store, hash } from '../src/store.js';
import { explore, reproduce } from '../src/explorer.js';
import { ModelClient } from '../src/model-client.js';
import { explorationFixture } from '../src/exploration-fixture.js';
import { observeControls, blockedReason, parsePlan } from '../src/exploration-policy.js';
import { commandFor } from '../src/interaction-contract.js';
import { dispatch } from '../src/browser-interactions.js';
import { testFormRules, authorizeForm } from '../src/form-policy.js';
import { diagnosticText, diagnosticUrl, COMPLETION_LIMITS } from '../src/action-outcome.js';
import { image } from '../src/recorder.js';
import type { ObservedControl } from '../src/contracts.js';

const submitter:ObservedControl={control_id:'a'.repeat(24),role:'button',name:'Search',href:null,disabled:false,ambiguous:false,submits_form:true,
  form:{action:'https://app.test/search',method:'get',target:'',search:true,unsafe:false,authorization:null,signature:'fields'}};
test('submit is a distinct permitted command; model/page flags cannot grant an unconfigured write',()=>{
  const search=authorizeForm(structuredClone(submitter),'https://app.test',[]);
  assert.equal(commandFor(search,{type:'submit'}).type,'submit');
  assert.throws(()=>commandFor(search,{type:'click'}));
  const write=authorizeForm({...submitter,form:{...submitter.form!,method:'post',authorization:'configured_test_form'}},'https://app.test',[]);
  assert.equal(write.form!.authorization,null);assert.ok(blockedReason(write,'https://app.test'));
  const rule={action_url:'https://app.test/search',method:'post' as const,submitter:'Search'};
  const allowed=authorizeForm(structuredClone(write),'https://app.test',[rule]);
  assert.equal(commandFor(allowed,{type:'submit'}).type,'submit');
  for(const change of [{unsafe:true},{target:'_blank'},{action:'https://other.test/search'},{action:'https://app.test/delete'},{method:'dialog'}]){
    assert.equal(authorizeForm({...submitter,form:{...submitter.form!,...change}},'https://app.test',[rule]).form!.authorization,null);
  }
  assert.throws(()=>testFormRules('[{"action_url":"https://app.test/*","method":"any"}]'));
  assert.throws(()=>testFormRules(JSON.stringify([{...rule,action_url:rule.action_url+'?token=secret'}])));
  assert.throws(()=>parsePlan({candidates:[{control_id:search.control_id,goal:'search',expected_result:'results',likelihood:.9,action:{type:'submit',url:'https://other.test/'}}],stop_reason:null},[search]));
});
test('diagnostics remove query strings, fragments, credentials and common secret patterns',()=>{
  assert.equal(diagnosticUrl('https://user:pass@app.test/search?q=private#private'),'https://app.test/search');
  const redacted=diagnosticText('Failed https://app.test/query?token=secret password=secret token=fixture-secret Bearer abc.def user@example.test');
  for(const marker of ['?token','fixture-secret','abc.def','user@example.test','password=secret'])assert.ok(!redacted.includes(marker),redacted);
});

test('real-browser action completion, diagnostics and safe form journeys',{
  skip:process.env.SCOUT_EXPLORER_INTEGRATION!=='1',timeout:300000,
},async t=>{
  const store=await new Store().open(),fixture=await explorationFixture();
  const client=new ModelClient({provider:'openrouter',model:'scout-outcomes-fixture:free',freeOnly:true});
  const options={client,allowedOrigins:[fixture.url],maxActions:7};
  const saved:Record<string,string>={};
  try {
    await t.test('validation then delayed search then the newly exposed result then another branch',async()=>{
      const result=await explore(store,fixture.url+'/journeys/search',options);saved.search=result.run_id;
      assert.equal(result.report.run.lifecycle,'completed',result.report.run.error);
      assert.deepEqual(result.report.actions.slice(0,5).map(a=>a.spec.command.type),['navigate','submit','fill','submit','click']);
      const [,,fill,search]=result.report.actions;
      assert.equal(fill.spec.command.value,'notebook');
      const validation=result.report.captures.find(c=>c.capture_id===result.report.actions[1].after_capture_id)!;
      assert.ok(validation.observation.text.includes('Enter a search term'));
      assert.ok(validation.observation.controls.some((c:ObservedControl)=>c.validation_message));
      assert.equal(search.outcome.status,'settled');assert.ok(search.outcome.elapsed_ms>=1300);
      assert.ok(search.outcome.visual_changes>0);
      assert.ok(result.report.captures.find(c=>c.capture_id===search.after_capture_id)!.observation.text.includes('Results ready'));
      assert.ok(result.report.actions.some(a=>a.spec.command.control?.name==='Help'));
      assert.ok(result.report.actions.every(a=>a.assessment.verdict==='no_issue_observed'));
      const frames=result.report.events.filter(e=>e.action_id===search.action_id&&e.event_type==='action.settling_frame').map(e=>e.payload);
      assert.ok(frames.length>=3);
      assert.equal(new Set(frames.map(f=>f.frame_id)).size,frames.length);
      for(const frame of frames)assert.equal(hash(await store.get(frame.artifact.object_key)),frame.sha256);
      const diagnostic=JSON.parse((await store.get(search.outcome.diagnostics_artifact.object_key)).toString());
      const request=diagnostic.events.find((e:any)=>e.kind==='request'&&e.url.endsWith('/journeys/result'));
      assert.ok(request);assert.ok(diagnostic.events.some((e:any)=>e.request_id===request.request_id&&e.kind==='response'&&e.status===200));
      assert.ok(!JSON.stringify(diagnostic).includes('q=notebook'));
      const manifest=JSON.parse((await store.get(result.report.run.manifest_key)).toString());
      assert.equal(manifest.actions.find((a:any)=>a.action_id===search.action_id).outcome.samples,frames.length);
      assert.ok(manifest.artifacts.some((a:any)=>a.kind==='action_completion'));
    });
    await t.test('failed HTTP, network and console evidence support a suspect and reproduce it with the exact form inputs',async()=>{
      const source=await explore(store,fixture.url+'/journeys/broken',{...options,maxActions:4});saved.failure=source.run_id;
      assert.equal(source.report.run.lifecycle,'completed',source.report.run.error);
      const failed=source.report.actions.at(-1)!;
      assert.equal(failed.spec.command.type,'submit');assert.equal(failed.assessment.verdict,'suspect');
      assert.equal(failed.outcome.status,'settled');
      assert.ok(failed.outcome.diagnostics.http_errors>=1);assert.ok(failed.outcome.diagnostics.request_failures>=1);assert.ok(failed.outcome.diagnostics.console_errors>=2);
      const log=JSON.stringify(failed.outcome.diagnostic_events);assert.ok(log.includes('503'));assert.ok(!log.includes('fixture-secret'));
      const replay=await reproduce(store,failed.action_id,options);saved.replay=replay.run_id;
      assert.equal(replay.report.run.lifecycle,'completed',replay.report.run.error);
      assert.equal(replay.report.reproductions[0].result.outcome,'reproduced');
      assert.deepEqual(replay.report.actions.map(a=>a.spec.command),source.report.actions.map(a=>a.spec.command));
      assert.ok(replay.report.actions.every(a=>a.outcome.status==='settled'));
    });
    await t.test('configured test form can write, while an unconfigured write stays blocked',async()=>{
      const denied=await explore(store,fixture.url+'/journeys/draft',{...options,maxActions:2});
      assert.ok(denied.report.graph.frontier.some((f:any)=>f.control.name==='Save test draft'&&f.status==='blocked'));
      const rules=[{action_url:fixture.url+'/journeys/draft-result',method:'post' as const,submitter:'Save test draft'}];
      const result=await explore(store,fixture.url+'/journeys/draft',{...options,maxActions:4,testFormRules:rules});saved.draft=result.run_id;
      assert.equal(result.report.run.lifecycle,'completed',result.report.run.error);
      assert.deepEqual(result.report.actions.map(a=>a.spec.command.type),['navigate','submit','fill','submit']);
      assert.ok(result.report.captures.find(c=>c.capture_id===result.report.actions[3].after_capture_id)!.observation.text.includes('Draft saved'));
      assert.equal(result.report.actions[3].spec.command.control.form.authorization,'configured_test_form');
    });
    await t.test('failed final screenshot preserves diagnostics and sampled frames without making a bug claim',async()=>{
      const result=await explore(store,fixture.url+'/journeys/broken',{...options,maxActions:4,hooks:{screenshot:async(page,phase,ordinal)=>{
        if(phase==='after'&&ordinal===4)throw new Error('Injected final capture failure');
        return image(page);
      }}});
      assert.equal(result.report.run.lifecycle,'failed');
      const action=result.report.actions.at(-1)!;
      assert.equal(action.state,'evidence_failed');assert.equal(action.assessment.verdict,'inconclusive');
      assert.equal(action.outcome.status,'observation_failed');assert.ok(action.outcome.diagnostics.http_errors>0);
      assert.ok(result.report.events.some(e=>e.action_id===action.action_id&&e.event_type==='action.settling_frame'));
    });
    await t.test('continuous activity times out once, remains inconclusive and never plans another action',async()=>{
      for(const path of ['/journeys/busy','/journeys/animation']){
        const result=await explore(store,fixture.url+path,{...options,maxActions:4});saved[path.split('/').at(-1)!]=result.run_id;
        assert.equal(result.report.run.lifecycle,'completed',result.report.run.error);
        assert.equal(result.report.run.config.stop_reason,'action_completion_unresolved');
        assert.equal(result.report.actions.length,2);
        const action=result.report.actions[1];
        assert.equal(action.assessment.verdict,'inconclusive');assert.equal(action.outcome.status,'timed_out');
        assert.ok(action.outcome.elapsed_ms<COMPLETION_LIMITS.timeout_ms+3000);
        assert.ok(action.outcome.samples<=COMPLETION_LIMITS.max_frames);
        assert.equal(result.report.graph.edges.length,2);
      }
    });
    await t.test('sensitive fields, external submitter overrides and changed destinations cannot bypass dispatch checks',async()=>{
      const browser=await chromium.launch({headless:true,chromiumSandbox:false});
      try{
        const page=await browser.newPage();await page.goto(fixture.url+'/journeys/policies');
        const controls=(await observeControls(page,[])).controls.filter(c=>c.submits_form);
        assert.equal(controls.length,5);assert.ok(controls.every(c=>blockedReason(c,fixture.url)));
        await page.goto(fixture.url+'/journeys/search');
        const submit=(await observeControls(page,[])).controls.find(c=>c.name==='Search')!;
        const command=commandFor(submit,{type:'submit'});
        await page.evaluate(()=>{document.querySelector('button')!.setAttribute('formaction','/forbidden-changed');});
        await assert.rejects(dispatch(page,command,[]),/changed/);
        assert.ok(!fixture.requests.some(path=>path.startsWith('/forbidden')));
      }finally{await browser.close();}
    });
    await store.flush();
    const count=JSON.parse(await store.clickhouse(`SELECT count() AS count FROM scout.runtime_events WHERE run_id='${saved.search}' AND event_type='action.outcome_recorded' FORMAT JSON`));
    assert.ok(Number(count.data[0].count)>=5);
    console.log('OUTCOME_VERIFIED_RUNS '+JSON.stringify(saved));
  }finally{await fixture.close();await store.close();}
});
