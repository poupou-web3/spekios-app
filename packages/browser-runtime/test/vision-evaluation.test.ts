import test from 'node:test';
import assert from 'node:assert/strict';
import {labelActions,selectCases,judgeInput,parseJudgment,summarize,markdownReport,stableId} from '../evaluation/core.mjs';
const label={expected:'bug',rubrics:[{id:'wishlist',title:'Wishlist',expected:'Saved',actual:'No feedback'}]};
const result=(reason='Nothing happens')=>({verdict:'suspect',expectation_uncertain:false,reason,observed_result:reason});
const arm=(r:any=result(),extra:any={})=>({result:r,initial_result:r,used_crops:true,fallback:false,...extra});
const pair=(extra:any={})=>({case_id:'case-1',source:{run_id:'run',action_id:'action'},label,repeat:1,full:arm(),optimized:arm(result('Save produces no visible feedback')),
 judgment:{full:{same_failure:true,reason:'Matched'},optimized:{same_failure:true,reason:'Equivalent'},optimized_initial:{same_failure:true,reason:'Equivalent'}},...extra});
const experiment=(pairs:any[],extra:any={})=>({id:'test',mode:'live',complete:true,pairs,calls:[],planned_pairs:pairs.length,...extra});
test('equivalent descriptions retain detection without string equality',()=>{
 const p=pair(),negative=pair({case_id:'negative',label:{expected:'correct',rubrics:[]},full:arm({verdict:'no_issue_observed'}),optimized:arm({verdict:'no_issue_observed'})});
 assert.notEqual(p.full.result.reason,p.optimized.result.reason);const s=summarize(experiment([p,negative]));assert.equal(s.retention,1);assert.equal(s.quality_gate,'pass_on_sample');
 const input=judgeInput(label,p.full.result,p.optimized.result);assert(!JSON.stringify(input).includes('full'));assert.match(input.instruction,/different wording/);
});
test('a different defect, inconclusive response and a missing detection count as loss',()=>{
 for(const updated of [{judgment:{full:{same_failure:true},optimized:{same_failure:false},optimized_initial:{same_failure:false}}},{optimized:arm({verdict:'inconclusive',expectation_uncertain:true})},{optimized:arm({verdict:'no_issue_observed',expectation_uncertain:false})}]){
  const s=summarize(experiment([pair(updated)]));assert.equal(s.lost.length,1);assert.equal(s.quality_gate,'regression');
 }
});
test('initial crop misses remain visible when a full fallback recovers the problem',()=>{
 const p=pair({optimized:arm(result(),{initial_result:{verdict:'inconclusive',expectation_uncertain:true},fallback:true}),judgment:{full:{same_failure:true},optimized:{same_failure:true},optimized_initial:{same_failure:false}}});
 const s=summarize(experiment([p]));assert.equal(s.crop_only.initial_detected,0);assert.equal(s.crop_only.final_detected,1);assert.equal(s.fallback_pairs,1);assert.equal(s.crop_only.lost_initial.length,1);
});
test('unlabelled examples, absent negatives and fixture outputs cannot establish quality',()=>{
 assert.equal(summarize(experiment([pair()])).quality_gate,'insufficient_evidence');
 assert.equal(summarize(experiment([pair()],{mode:'scripted_fixture'})).quality_gate,'unverified_scripted_models');
 assert.equal(summarize(experiment([pair()],{complete:false})).quality_gate,'incomplete');
 const unknown=pair({label:{expected:'unlabelled',rubrics:[]}});assert.equal(summarize(experiment([unknown])).known_positive_pairs,0);
});
test('optimized usage includes every fallback call, missing costs stay unknown and judge overhead is separate',()=>{
 const call=(role:string,tokens:number,cost:number|null)=>({role,input_tokens:tokens,output_tokens:20,elapsed_ms:100,provider_cost_usd:cost,demo_charged_usd:cost});
 const s=summarize(experiment([pair()],{calls:[call('full',100,1),call('optimized',20,.2),call('optimized',100,1),call('judge',50,null)]}));
 assert.equal(s.usage.optimized.input_tokens,120);assert.equal(s.usage.optimized.demo_charged_usd,1.2);assert.equal(s.usage.judge.provider_cost_usd,null);
});
test('stable identity, label-balanced selection and strict semantic output parsing',()=>{
 assert.equal(stableId('dataset','case'),stableId('dataset','case'));assert.notEqual(stableId('dataset','case'),stableId('dataset','other'));
 const cases=[1,2,3,4].map(n=>({id:String(n),label:n<4?label:{expected:'correct',rubrics:[{id:'negative'}]}}));assert.equal(selectCases(cases,2).some(c=>c.label.expected==='correct'),true);
 assert.throws(()=>parseJudgment({a:{same_failure:'yes',reason:'guess'},b:{same_failure:false,reason:'no'}}));
 assert.match(markdownReport(experiment([pair({optimized:arm(result('<script>bad()</script>'))})])),/&lt;script&gt;/);
});
test('nth-action planted bugs are labelled per source run and fixed builds remain negative',()=>{
 const captures=[{capture_id:'b',observation:{url:'https://larchwood.test/product/x'}},{capture_id:'a',observation:{url:'https://larchwood.test/product/x'}}];
 const actions=[1,2,3].map(ordinal=>({action_id:String(ordinal),ordinal,before_capture_id:'b',after_capture_id:'a',spec:{command:{type:'click',control:{role:'button',name:'Add'}}}}));
 const manifest={bugs:[{id:'flaky',viewport:'any',match:{control:'^Add$',every:2},expected:'Added',actual:'No add'}],decoys:[]};
 const labels=labelActions({captures,actions,run:{config:{}}},manifest,'faulty');assert.deepEqual([...labels.keys()],['2']);assert.equal(labels.get('2').expected,'bug');assert.equal(labelActions({captures,actions,run:{config:{}}},manifest,'fixed').get('2').expected,'correct');
});

test('shared misses do not prove equivalence and ambiguous grading is not a confirmed regression',()=>{
 const negative=pair({case_id:'negative',label:{expected:'correct',rubrics:[]},full:arm({verdict:'no_issue_observed'}),optimized:arm({verdict:'no_issue_observed'})});
 const bothMiss=pair({full:arm({verdict:'no_issue_observed'}),optimized:arm({verdict:'no_issue_observed'}),judgment:{full:{same_failure:false},optimized:{same_failure:false},optimized_initial:{same_failure:false}}});
 assert.equal(summarize(experiment([bothMiss,negative])).quality_gate,'insufficient_evidence');
 const ambiguous=pair({judgment:{full:{same_failure:true},optimized:{same_failure:null},optimized_initial:{same_failure:null}}});const s=summarize(experiment([ambiguous,negative]));
 assert.equal(s.quality_gate,'insufficient_evidence');assert.equal(s.retention,null);assert.equal(s.retained,0);assert.equal(s.lost.length,0);assert.equal(s.unresolved_retention,1);
 const falseAlarm={...negative,optimized:arm(result('An ordinary validation message is a bug'))};assert.equal(summarize(experiment([pair(),falseAlarm])).quality_gate,'regression');
});
