import {appSource} from './support.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

// Pure templates only: no browser, model request, image download or evidence mutation.
function evidenceUI(){
  const node={innerHTML:'',classList:{add(){},remove(){}},addEventListener(){},querySelectorAll(){return[];}};
  const sandbox={document:{querySelector(){return node;},addEventListener(){}},window:{addEventListener(){}},sessionStorage:{getItem(){return null;}},setInterval(){},setTimeout(){return 0;},clearTimeout(){},URL};
  vm.createContext(sandbox);
  vm.runInContext(appSource('main.js')+'\nglobalThis.testing={state,actionDetail,imagePanel,drawer};',sandbox);
  return sandbox.testing;
}
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const recordedAction=(n,extra={})=>({action_id:id(n),ordinal:n,state:'completed',before_capture_id:id(n+10),after_capture_id:id(n+20),spec:{command:{type:'click',control:{name:'Open result'}},prediction:{expected_result:'The result opens'}},assessment:{verdict:'no_issue_observed',reason:'Result visible'},comparison:{counts:{changed_pixels:1}},...extra});
function report(ui,actions=[recordedAction(1)]){
  ui.state.report={run:{run_id:id(100),lifecycle:'completed',config:{runtime_version:'explorer-v1',replay_of:null}},actions,captures:actions.flatMap(a=>[{capture_id:a.before_capture_id,status:'available'},{capture_id:a.after_capture_id,status:'available'}]),events:[],reproductions:[],finding_reviews:[]};
  ui.state.actionId=actions[0].action_id;return ui.state.report;
}
const navButton=(html,action)=>html.match(new RegExp('<button[^>]+data-action="'+action+'"[^>]*>'))?.[0]||'';

test('compare presents two authenticated recorded images, separate capture IDs and full-resolution controls',()=>{
  const ui=evidenceUI(),data=report(ui),before=JSON.stringify(data);ui.state.image='compare';
  const html=ui.actionDetail();
  assert.match(html,/data-value="compare" aria-pressed="true"/);
  assert.match(html,/aria-label="Before and after recorded screenshots"/);
  assert.match(html,/Before action/);assert.match(html,/After action/);
  assert.ok(html.includes(`/v1/captures/${id(11)}/image`));assert.ok(html.includes(`/v1/captures/${id(21)}/image`));
  assert.equal((html.match(/data-image-path=/g)||[]).length,2);
  assert.equal((html.match(/data-action="zoom-image"/g)||[]).length,2);
  assert.match(html,/aria-label="Copy before capture ID"/);assert.match(html,/aria-label="Copy after capture ID"/);
  assert.match(html,/1 changed pixels/);assert.match(html,/Screenshots are shown independently/);assert.match(html,/do not establish a bug/);
  assert.equal(JSON.stringify(data),before);
});

test('compare distinguishes pending collection from permanent gaps while retaining recorded capture IDs',()=>{
  const ui=evidenceUI(),data=report(ui);ui.state.image='compare';
  data.captures[1].status='pending_upload';
  let html=ui.actionDetail();assert.match(html,/Evidence is being collected/);assert.doesNotMatch(html,/explicit evidence gap/);assert.ok(html.includes(id(21)));assert.equal((html.match(/data-action="zoom-image"/g)||[]).length,1);
  data.captures[1].status='failed';html=ui.actionDetail();assert.match(html,/No image available/);assert.match(html,/explicit evidence gap/);assert.ok(html.includes(id(21)));
  data.actions[0].state='dispatched';data.actions[0].after_capture_id=null;data.captures.pop();
  html=ui.actionDetail();assert.match(html,/Evidence is being collected/);assert.match(html,/No capture ID/);assert.doesNotMatch(html,/\/v1\/captures\/null/);
});

test('comparison captions, IDs, expectations and control labels remain escaped text',()=>{
  const ui=evidenceUI(),data=report(ui),attack='\"><img src=x onerror="bad()"><script>bad()</script>';
  const action=data.actions[0];action.before_capture_id=attack;data.captures[0].capture_id=attack;action.spec.command.control.name=attack;action.spec.prediction.expected_result=attack;ui.state.image='compare';
  const html=ui.actionDetail();assert.ok(html.includes('&lt;script&gt;'));assert.ok(html.includes('&quot;&gt;'));assert.doesNotMatch(html,/<script>|<img src=x/);
  assert.match(html,/data-action="copy"/);assert.match(html,/data-action="zoom-image"/);
});

test('individual before, after, mask and settling-frame evidence remain selectable',()=>{
  const ui=evidenceUI(),data=report(ui);data.actions[0].comparison.raw_mask_artifact={artifact_id:id(70)};
  data.events=[{action_id:id(1),event_type:'action.settling_frame',payload:{frame_id:id(71),offset_ms:200,artifact:{artifact_id:id(72)}}}];
  for(const [view,path,reference] of [['before',`/v1/captures/${id(11)}/image`,id(11)],['after',`/v1/captures/${id(21)}/image`,id(21)],['mask',`/v1/artifacts/${id(70)}/content`,id(70)],['frame',`/v1/artifacts/${id(72)}/content`,id(71)]]){
    ui.state.image=view;ui.state.frameId=id(71);const html=ui.actionDetail();assert.ok(html.includes(path));assert.ok(html.includes(reference));assert.equal((html.match(/data-image-path=/g)||[]).length,1);assert.match(html,/Difference mask/);
  }
});

test('previous and next recorded action controls expose positions and disable only the list boundaries',()=>{
  const ui=evidenceUI();report(ui,[recordedAction(1),recordedAction(2),recordedAction(3)]);
  let html=ui.actionDetail();assert.match(html,/Action 1 of 3/);assert.match(navButton(html,'prev-action'),/disabled/);assert.doesNotMatch(navButton(html,'next-action'),/disabled/);assert.ok(navButton(html,'next-action').includes(id(2)));
  ui.state.actionId=id(2);html=ui.actionDetail();assert.match(html,/Action 2 of 3/);assert.doesNotMatch(navButton(html,'prev-action'),/disabled/);assert.doesNotMatch(navButton(html,'next-action'),/disabled/);assert.ok(navButton(html,'prev-action').includes(id(1)));assert.ok(navButton(html,'next-action').includes(id(3)));
  ui.state.actionId=id(3);html=ui.actionDetail();assert.match(html,/Action 3 of 3/);assert.match(navButton(html,'next-action'),/disabled/);assert.doesNotMatch(navButton(html,'prev-action'),/disabled/);
  report(ui);html=ui.actionDetail();assert.match(html,/Action 1 of 1/);assert.match(navButton(html,'prev-action'),/disabled/);assert.match(navButton(html,'next-action'),/disabled/);
});

test('finding navigation follows its active review filter rather than hidden action rows',()=>{
  const ui=evidenceUI(),actions=[1,2,3].map(n=>recordedAction(n,{assessment:{verdict:'suspect',expectation_uncertain:true}})),data=report(ui,actions);
  data.run.lifecycle='active';data.finding_reviews=[{action_id:id(2),revision:1,disposition:'dismissed'}];ui.state.tab='findings';ui.state.findingFilter='needs_review';
  const html=ui.actionDetail();assert.match(html,/Action 1 of 2 in this filter/);assert.ok(navButton(html,'next-action').includes(id(3)));assert.ok(!navButton(html,'next-action').includes(id(2)));
});

test('native image drawer retains focusable scrolling and explicit fit mode for comparison image controls',()=>{
  const ui=evidenceUI(),path=`/v1/captures/${id(11)}/image`;ui.state.drawer={title:'Recorded screenshot',image:{path,alt:'Before screenshot <script>bad()</script>',fit:false}};
  let html=ui.drawer();assert.match(html,/native-resolution/);assert.match(html,/Actual pixels · 100%/);assert.match(html,/tabindex="0" role="region" aria-label="Scrollable screenshot"/);assert.ok(html.includes(path));assert.doesNotMatch(html,/<script>/);
  ui.state.drawer.image.fit=true;html=ui.drawer();assert.match(html,/fit-resolution/);assert.match(html,/View actual pixels/);
});

test('AI image tabs expose recorded derivatives separately from originals and identify full-screen reassessment',()=>{
  const ui=evidenceUI(),data=report(ui),action=data.actions[0];
  action.comparison.assessment_images={mode:'overview_and_crops',pixel_fraction:.16,artifacts:[{artifact_id:id(81)},{artifact_id:id(82)}]};
  ui.state.image='model-after';let html=ui.actionDetail();assert.match(html,/AI before/);assert.match(html,/AI after/);assert.match(html,/16% of original image pixels/);assert.ok(html.includes(`/v1/artifacts/${id(82)}/content`));
  action.assessment.visual_screening={request_id:id(91)};html=ui.actionDetail();assert.match(html,/final assessment used full screenshots/);
  ui.state.image='before';assert.ok(ui.actionDetail().includes(`/v1/captures/${id(11)}/image`));
  action.comparison.assessment_images={mode:'full'};ui.state.image='model-after';html=ui.actionDetail();assert.doesNotMatch(html,/\/v1\/artifacts\/undefined|AI after/);
});
