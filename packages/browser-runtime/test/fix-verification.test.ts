import test from 'node:test';
import assert from 'node:assert/strict';
import {remapUrl,remapCommand,preconditionsMatch,bindVerificationCommand,parseFixAssessment,verificationOutcome} from '../src/fix-verification.js';
import type {Capture,BrowserCommand} from '../src/contracts.js';
import type {Replay} from '../src/reproduction.js';
const source='https://app.example/editor',candidate='https://preview.example/drafts';
const control={control_id:'source-id',role:'button',name:'Save draft',href:null,enabled:true,visible:true,rect:{x:0,y:0,width:20,height:10}};
function capture(url=source):Capture{return {capture_id:'before',sha256:'source-pixels',observation:{url,title:'Drafts',text:'Ready Save draft',text_truncated:false,viewport:{width:1440,height:900},device_scale:1,scroll:{x:0,y:0},controls_truncated:false,controls:[control]}} as unknown as Capture;}
function fixtures(){
  const step=(id:string)=>({source_action_id:id,before:{capture_id:id+'-before'},after:{capture_id:id+'-after'},expected_result:'Saved is visible'});
  const replay={source_run_id:'source-run',source_action_id:'save',target_url:candidate,steps:[step('navigate'),step('save')],fix_verification:{original:{expected_result:'Saved is visible'}}} as unknown as Replay;
  const action=(id:string)=>({action_id:'fresh-'+id,state:'completed',spec:{replay_source_action_id:id,prediction:{expected_result:'Saved is visible'}},outcome:{status:'settled'},before_capture_id:'fresh-'+id+'-before',after_capture_id:'fresh-'+id+'-after',assessment:{verdict:'no_issue_observed',observed_result:'Saved',expectation_uncertain:false,fix_check:{preconditions_met:true,expectation_met:true,same_failure_observed:false}}});
  const report={run:{run_id:'candidate-run',lifecycle:'completed'},actions:[action('navigate'),action('save')]};return {report,replay};
}
test('deployment mapping preserves the explicit candidate entry path and maps only the original origin',()=>{
  assert.equal(remapUrl(source+'#draft',source,candidate),candidate+'#draft');
  assert.equal(remapUrl('https://app.example/settings?tab=one',source,candidate),'https://preview.example/settings?tab=one');
  assert.equal(remapUrl('https://external.example/help',source,candidate),'https://external.example/help');
  assert.equal(remapUrl('https://app.example/editor?other=1',source,candidate),'https://preview.example/editor?other=1');
  const command={type:'click',control:{...control,href:source,form:{signature:'old',action:source,method:'post'}}} as unknown as BrowserCommand;
  const mapped=remapCommand(command,source,candidate) as any;assert.equal(mapped.control.href,candidate);assert.equal(mapped.control.form.action,candidate);
});
test('candidate controls are rebound only after equivalent recorded DOM and native state',()=>{
  const before=capture(),fresh=capture(candidate);fresh.sha256='new-css-pixels';fresh.observation.controls![0]={...control,control_id:'fresh-id',rect:{x:50,y:10,width:20,height:10}} as any;
  assert.equal(preconditionsMatch(before,fresh,source,candidate),true,'Changed deployment pixels alone do not change behavioral preconditions');
  const command={type:'click',control} as unknown as BrowserCommand;
  const step={before,command} as any;const verification={source_entry:source,candidate_url:candidate} as any;
  assert.equal((bindVerificationCommand(step,fresh,verification) as any).control.control_id,'fresh-id');
  fresh.observation.text='Different account or page';assert.equal(preconditionsMatch(before,fresh,source,candidate),false);assert.throws(()=>bindVerificationCommand(step,fresh,verification),/No action dispatched/);
});
test('missing, disabled, occluded, truncated or differently authenticated preconditions are not silently healed',()=>{
  for(const change of [(c:any)=>c.observation.controls=[],(c:any)=>c.observation.controls[0].enabled=false,(c:any)=>c.observation.controls[0].occluded=true,(c:any)=>c.observation.controls_truncated=true,(c:any)=>c.observation.auth_context_id='different-auth']){
    const before=capture(),fresh=structuredClone(capture(candidate));change(fresh);assert.equal(preconditionsMatch(before,fresh,source,candidate),false);
  }
});
test('verification parsing requires explicit, consistent positive checks and exactly the fresh evidence pair',()=>{
  const base={verdict:'no_issue_observed',reason:'Saved is visible',observed_result:'Saved',evidence_capture_ids:['one','two'],expectation_uncertain:false};
  assert.throws(()=>parseFixAssessment(base,['one','two']),/explicit/);
  const positive={...base,expectation_met:true,preconditions_met:true,same_failure_observed:false};
  assert.equal(parseFixAssessment(positive,['one','two']).fix_check.expectation_met,true);
  assert.throws(()=>parseFixAssessment({...positive,same_failure_observed:true},['one','two']),/Contradictory/);
  assert.throws(()=>parseFixAssessment({...positive,evidence_capture_ids:['old-source','two']},['one','two']));
});
test('resolved requires a fully completed frozen path, verified bytes and an explicit positive expected result',()=>{
  const {report,replay}=fixtures();const result=verificationOutcome(report,replay,true);assert.equal(result.outcome,'resolved');assert.equal(result.verified_fixed_globally,false);assert.equal(result.confirmed_bug,false);assert.equal(result.positive_expectation_check,true);assert.deepEqual(result.source_capture_ids,['save-before','save-after']);assert.deepEqual(result.candidate_capture_ids,['fresh-save-before','fresh-save-after']);
});
test('the same failure is still reproducible only under matching preconditions',()=>{
  const {report,replay}=fixtures();const final=report.actions[1].assessment;final.verdict='suspect';final.fix_check.expectation_met=false;final.fix_check.same_failure_observed=true;
  assert.equal(verificationOutcome(report,replay,true).outcome,'still_reproducible');
  final.fix_check.preconditions_met=false;assert.equal(verificationOutcome(report,replay,true).outcome,'inconclusive');
});
test('absence of a new suspicion, evidence loss and all incomplete execution paths cannot establish a fix',()=>{
  const mutations=[(r:any)=>delete r.actions[1].assessment.fix_check,(r:any)=>r.actions.pop(),(r:any)=>r.actions[0].assessment.verdict='suspect',(r:any)=>r.actions[1].spec.replay_source_action_id='another-action',(r:any)=>r.actions[1].state='evidence_failed',(r:any)=>r.actions[1].tool_error='timeout',(r:any)=>r.actions[1].outcome.status='timeout',(r:any)=>r.actions[1].assessment.expectation_uncertain=true,(r:any)=>r.run.lifecycle='failed',(r:any)=>r.run.lifecycle='cancelled',(r:any)=>r.run.cancel_id='pending-cancellation'];
  for(const mutate of mutations){const {report,replay}=fixtures();mutate(report);assert.equal(verificationOutcome(report,replay,true).outcome,'inconclusive');}
  const {report,replay}=fixtures();assert.equal(verificationOutcome(report,replay,false).outcome,'inconclusive');
  report.run.lifecycle='blocked';assert.equal(verificationOutcome(report,replay,false).outcome,'blocked');
});
