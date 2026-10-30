import test from 'node:test';
import assert from 'node:assert/strict';
import {reportEvidence,reportMarkdown,reportSummary} from '../src/report/export.js';

const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const digest='a'.repeat(64),otherDigest='b'.repeat(64),runId=id(1),actionId=id(2);
const capture=(n,phase,extra={})=>({capture_id:id(n),run_id:runId,action_id:actionId,phase,status:'available',sha256:digest,byte_length:8,object_key:`workspace/blobs/${digest}.png`,...extra});
const artifact=(n,kind='raw_mask',extra={})=>({artifact_id:id(n),run_id:runId,kind,status:'available',sha256:digest,byte_length:8,object_key:`workspace/blobs/${digest}.${kind==='raw_mask'||kind==='settling_frame'?'png':'json'}`,...extra});
function fixture(){
  return {run:{run_id:runId,target_url:'https://app.test/results',lifecycle:'completed',created_at:'2026-10-29T08:00:00Z',finished_at:'2026-10-29T08:00:05Z',config:{runtime_version:'explorer-v1',replay_of:null,execution_mode:'protocol_fixture',training_status:'excluded_fixture',viewport_profile:'mobile',limits:{max_actions:6},stop_reason:'action_budget_exhausted'}},
    actions:[{action_id:actionId,run_id:runId,ordinal:1,state:'completed',before_capture_id:id(3),after_capture_id:id(4),spec:{command:{type:'click',control:{control_id:'open',name:'Open results',role:'button'}},prediction:{goal:'Inspect results',expected_result:'Results open'}},assessment:{verdict:'suspect',expectation_uncertain:false,observed_result:'Results remain hidden',reason:'The expected results did not appear'},comparison:{counts:{changed_pixels:1},raw_mask_artifact:{artifact_id:id(5),kind:'raw_mask',sha256:digest,byte_length:8,object_key:`workspace/blobs/${digest}.png`}}}],
    captures:[capture(3,'before'),capture(4,'after')],artifacts:[artifact(5)],events:[],finding_reviews:[],reproductions:[],automatic_reproductions:[],graph:{states:[{}],edges:[{}],frontier:[{status:'blocked',control:{name:'Pay'},reason:'Payment requires a handoff'},{status:'unexplored'}]},model_calls:[],model_usage:{attempts:0,known_input_tokens:null,known_output_tokens:null,incomplete_usage_attempts:0,pending_requests:0,provider_reported_cost_usd:null,unpriced_attempts:0}};
}
const options={exportId:id(90),generatedAt:'2026-10-29T08:10:00Z'};
const verified=item=>({...item,status:'included',verifiedSha256:item.sha256,verifiedBytes:item.byteLength});
const find=(entries,kind,n)=>entries.find(item=>item.kind===kind&&item.id===id(n));

test('inventory is deterministic, selected-run scoped and keeps separate capture occurrences with shared bytes',()=>{
  const report=fixture(),original=JSON.stringify(report);report.artifacts.push(artifact(7,'action_completion'));const inventory=reportEvidence(report);
  assert.deepEqual(inventory.map(e=>[e.kind,e.id]),[['artifact',id(5)],['artifact',id(7)],['capture',id(3)],['capture',id(4)]]);
  assert.equal(find(inventory,'capture',3).path,`captures/${id(3)}.png`);assert.equal(find(inventory,'capture',4).endpoint,`/v1/captures/${id(4)}/image`);
  assert.equal(find(inventory,'artifact',7).path,`artifacts/${id(7)}.json`);assert.equal(find(inventory,'artifact',5).mediaType,'image/png');
  report.captures.reverse();report.artifacts.reverse();assert.deepEqual(reportEvidence(report),inventory);
  report.artifacts=report.artifacts.filter(a=>a.artifact_id!==id(7));report.captures.reverse();assert.equal(JSON.stringify(report),original);
});

test('invalid IDs, foreign runs and conflicting duplicate metadata cannot produce download paths',()=>{
  for(const change of [r=>r.run.run_id='not-a-uuid',r=>r.captures[0].capture_id='../../secret.png',r=>r.captures[0].run_id=id(99),r=>r.captures.push({...r.captures[0],sha256:otherDigest})]){
    const report=fixture();change(report);const inventory=reportEvidence(report),invalid=inventory.filter(e=>e.status==='invalid');assert.ok(invalid.length);
    for(const item of invalid){assert.equal(item.path,null);assert.equal(item.endpoint,null);assert.ok(item.error);}
  }
  const report=fixture();report.captures.push({...report.captures[0]});assert.equal(reportEvidence(report).filter(e=>e.kind==='capture').length,2);
});

test('missing before/after rows and nested action/event artifact references become explicit nonfetchable gaps',()=>{
  const report=fixture();report.captures=[];report.artifacts=[];report.actions[0].outcome={completion_artifact:{artifact_id:id(7),kind:'action_completion'}};
  report.events=[{event_id:id(20),run_id:runId,action_id:actionId,seq:1,event_type:'action.outcome_recorded',payload:{diagnostics_artifact_id:id(8)}}];
  const inventory=reportEvidence(report);assert.equal(inventory.length,5);
  assert.deepEqual(new Set(inventory.map(e=>e.id)),new Set([3,4,5,7,8].map(id)));
  for(const item of inventory){assert.equal(item.status,'missing');assert.equal(item.endpoint,null);assert.equal(item.path,null);assert.match(item.error,/missing/);}
  const md=reportMarkdown(report,options);assert.match(md,/missing/);assert.ok(md.includes(id(3)));assert.ok(md.includes(id(8)));
});

test('bound capture action and phase mismatches invalidate the referenced evidence',()=>{
  for(const patch of [{action_id:id(99)},{phase:'after'}]){
    const report=fixture();Object.assign(report.captures[0],patch);const before=find(reportEvidence(report),'capture',3);assert.equal(before.status,'invalid');assert.equal(before.endpoint,null);assert.match(before.error,/action/);
  }
  const report=fixture();report.actions[0].after_capture_id=id(3);const same=find(reportEvidence(report),'capture',3);assert.equal(same.status,'invalid');
});

test('nested artifact hash, size, kind and object-key contradictions cannot be fetched',()=>{
  for(const patch of [{sha256:otherDigest},{byte_length:9},{kind:'comparison'},{object_key:'workspace/other.png'},{run_id:id(99)}]){
    const report=fixture();Object.assign(report.actions[0].comparison.raw_mask_artifact,patch);const item=find(reportEvidence(report),'artifact',5);assert.equal(item.status,'invalid');assert.equal(item.endpoint,null);assert.match(item.error,/conflicts/);
  }
  const report=fixture();report.artifacts[0].object_key='blob.json';const item=find(reportEvidence(report),'artifact',5);assert.equal(item.status,'invalid');assert.match(item.error,/media/);
});

test('unbound failed capture rows are retained as failed gaps and pending metadata is not promoted to available',()=>{
  const report=fixture();report.actions[0].after_capture_id=null;report.actions[0].state='evidence_failed';Object.assign(report.captures[1],{status:'failed',sha256:null,byte_length:null,error:'Capture interrupted'});
  let inventory=reportEvidence(report);assert.equal(find(inventory,'capture',4).status,'failed');assert.equal(reportSummary(report).evidence.failed,1);
  report.captures[0].status='capturing';report.captures[0].sha256=null;report.captures[0].byte_length=null;inventory=reportEvidence(report);assert.equal(find(inventory,'capture',3).status,'capturing');
  const markdown=reportMarkdown(report,{...options,bundle:true,evidence:inventory});assert.match(markdown,/Capture interrupted/);assert.doesNotMatch(markdown,/!\[/);
});

test('foreign events and related-run review/reproduction evidence never grow the bundle inventory',()=>{
  const report=fixture();report.events=[{run_id:id(99),event_id:id(20),action_id:actionId,event_type:'action.settling_frame',payload:{artifact:{artifact_id:id(80)}}}];
  report.reproductions=[{source_run_id:runId,replay_run_id:id(70),source_action_id:actionId,source_snapshot:[{before_capture_id:id(81),artifact:{artifact_id:id(82)}}],result:{outcome:'reproduced',source_capture_ids:[id(3),id(4)],replay_capture_ids:[id(83),id(84)]}}];
  report.finding_reviews=[{run_id:runId,action_id:actionId,revision:1,disposition:'confirmed',evidence_snapshot:{artifacts:[{artifact_id:id(85)}]}}];
  assert.equal(reportEvidence(report).length,3);const markdown=reportMarkdown(report,options);assert.match(markdown,/Related run evidence outside the selected run/);assert.ok(markdown.includes(id(70)));assert.doesNotMatch(markdown,/artifacts\/00000000-0000-4000-8000-00000000008[0-5]/);
});

test('unique settling frame occurrences share one verified image artifact without losing occurrence IDs',()=>{
  const report=fixture();report.artifacts.push(artifact(9,'settling_frame'));
  report.events=[1,2].map(n=>({event_id:id(30+n),run_id:runId,action_id:actionId,seq:n,event_type:'action.settling_frame',payload:{frame_id:id(40+n),offset_ms:n*200,artifact:{artifact_id:id(9),sha256:digest,byte_length:8,kind:'settling_frame',object_key:`workspace/blobs/${digest}.png`}}}));
  const inventory=reportEvidence(report),summary=reportSummary(report),frame=find(inventory,'artifact',9);assert.equal(inventory.length,4);assert.equal(frame.references.length,2);assert.equal(summary.evidence.frameOccurrences,2);assert.equal(summary.evidence.uniqueFrameArtifacts,1);
  const markdown=reportMarkdown(report,options);assert.ok(markdown.includes(id(41)));assert.ok(markdown.includes(id(42)));assert.match(markdown,/Settling frame occurrences/);
});

test('standalone Markdown cannot turn hostile text into HTML, GFM links, images, headings or tables',()=>{
  const report=fixture(),attack='https://evil.test/x ![image](https://evil.test/leak) [click](javascript:bad) <script>bad()</script>\n# Fake heading\n| bad | row |\n```html\n<img src=x onerror=bad>\n```';
  report.run.target_url=attack;report.actions[0].spec.prediction.expected_result=attack;report.actions[0].spec.command.control.name=attack;report.actions[0].assessment.reason=attack;
  const markdown=reportMarkdown(report,options);assert.doesNotMatch(markdown,/<script>|<img|https:\/\/|javascript:|\n# Fake|\n\| bad/);assert.match(markdown,/&lt;script&gt;/);assert.match(markdown,/\\!\\\[image/);assert.match(markdown,/\\\| bad/);assert.match(markdown,/\\`\\`\\`/);
  assert.doesNotMatch(markdown,/(?<!\\)!\[/);assert.doesNotMatch(markdown,/(?<!\\)\[click\]\(/);
});

test('bundle images require matching safe relative paths and independent byte-verification receipts',()=>{
  const report=fixture(),inventory=reportEvidence(report),receipts=inventory.map(verified);
  const markdown=reportMarkdown(report,{...options,bundle:true,evidence:receipts});assert.ok(markdown.includes(`![Before action](captures/${id(3)}.png)`));assert.ok(markdown.includes(`![After action](captures/${id(4)}.png)`));assert.ok(markdown.includes(`![Exact difference mask](artifacts/${id(5)}.png)`));
  for(const patch of [{path:'https://evil.test/a.png'},{path:'../a.png'},{runId:id(99)},{sha256:otherDigest},{verifiedSha256:otherDigest},{verifiedBytes:9},{verifiedBytes:undefined},{status:'failed_verification'}]){
    const altered=receipts.map(r=>r.id===id(3)?{...r,...patch}:r),result=reportMarkdown(report,{...options,bundle:true,evidence:altered});assert.ok(!result.includes(`![Before action](captures/${id(3)}.png)`));assert.doesNotMatch(result,/(?<!\\)https:\/\//);
  }
});

test('latest human review governs candidate counts while full history and AI suspicion remain separate',()=>{
  const report=fixture();report.finding_reviews=[{run_id:runId,action_id:actionId,review_id:id(50),revision:1,disposition:'confirmed',rationale:'A product requirement was violated',expectation_basis:'Documented expected result',severity:'high'},{run_id:runId,action_id:actionId,review_id:id(51),revision:2,disposition:'needs_review',rationale:'Reopened for more evidence',expectation_basis:''}];
  let summary=reportSummary(report);assert.equal(summary.findings.needsReview,1);assert.equal(summary.findings.confirmed,0);assert.equal(summary.actions.verdicts.suspect,1);assert.equal(summary.findings.latestReviews[0].revision,2);assert.equal(Object.hasOwn(summary.findings.latestReviews[0],'evidence_snapshot'),false);
  let markdown=reportMarkdown(report,options);assert.match(markdown,/Reopened for more evidence/);assert.match(markdown,/A product requirement was violated/);assert.match(markdown,/separate from AI assessment/);assert.match(markdown,/training status/);
  report.finding_reviews[1].disposition='dismissed';summary=reportSummary(report);assert.equal(summary.findings.dismissed,1);assert.equal(report.actions[0].assessment.verdict,'suspect');
});

test('replay human reviews map source actions without importing unrelated decisions or source evidence',()=>{
  const report=fixture(),sourceRun=id(60),sourceAction=id(61);report.run.config.replay_of={source_run_id:sourceRun,source_action_id:sourceAction};report.actions[0].spec.replay_source_action_id=sourceAction;
  report.finding_reviews=[{run_id:sourceRun,action_id:sourceAction,review_id:id(50),revision:1,disposition:'confirmed',rationale:'Source decision'}, {run_id:id(62),action_id:id(63),review_id:id(64),revision:9,disposition:'confirmed',rationale:'Unrelated decision'}];
  const summary=reportSummary(report);assert.equal(summary.isReplay,true);assert.equal(summary.findings.candidates,0);assert.equal(summary.findings.confirmed,0);assert.equal(summary.findings.latestReviews.length,1);assert.equal(summary.findings.sourceReviewReferences.length,1);assert.equal(summary.actions.verdicts.suspect,1);const markdown=reportMarkdown(report,options);assert.match(markdown,/refer to the original finding/);assert.doesNotMatch(markdown,/Unrelated decision/);assert.equal(reportEvidence(report).length,3);
});

test('zero, unknown and partial usage never invent reported totals or successful coverage',()=>{
  const report=fixture();let summary=reportSummary(report),markdown=reportMarkdown(report,options);assert.equal(summary.usage.attempts,0);assert.equal(summary.usage.inputTokens,null);assert.match(markdown,/No provider attempts are recorded/);assert.match(markdown,/Input tokens \| Unknown/);assert.match(markdown,/Fixture data:\*\* Yes/);
  report.model_usage={attempts:2,known_input_tokens:0,known_output_tokens:9,incomplete_usage_attempts:1,pending_requests:1,provider_reported_cost_usd:'0',unpriced_attempts:1};summary=reportSummary(report);assert.equal(summary.usage.inputTokens,0);assert.equal(summary.usage.costUsd,'0');assert.equal(summary.usage.tokensComplete,false);markdown=reportMarkdown(report,options);assert.match(markdown,/At least 0/);assert.match(markdown,/known subtotal/);
  report.actions=[];report.run.lifecycle='cancelled';markdown=reportMarkdown(report,options);assert.match(markdown,/No actions were recorded\. This is not a passing test result/);assert.match(markdown,/Lifecycle:\*\* cancelled/);
  delete report.model_usage;delete report.model_calls;summary=reportSummary(report);assert.equal(summary.usage.attempts,null);assert.equal(summary.usage.incompleteUsageAttempts,null);
});

test('all execution states, automatic deferrals and long untrusted text retain honest bounded reporting',()=>{
  const report=fixture(),states=['prepared','dispatched','completed','evidence_failed','interrupted','skipped','cancelled'];report.actions=states.map((state,n)=>({...report.actions[0],action_id:id(100+n),ordinal:n+1,state,before_capture_id:null,after_capture_id:null,assessment:state==='completed'?{verdict:'no_issue_observed'}:null,comparison:null}));
  report.actions[0].spec={command:{type:'fill',value:'test value',control:{name:'Search',role:'searchbox'}},prediction:{expected_result:'x'.repeat(6000)}};report.automatic_reproductions=[{task_id:id(80),source_action_id:id(100),status:'pending',reason:'provider_unavailable',planned_actions:2,child_job:{status:'queued'}}];
  const summary=reportSummary(report),markdown=reportMarkdown(report,options);assert.equal(summary.actions.total,7);for(const state of states)assert.equal(summary.actions.states[state],1);assert.match(markdown,/truncated/);assert.match(markdown,/provider\\_unavailable/);assert.match(markdown,/Value:\*\* test value/);assert.match(markdown,/Unfinished children may settle/);
});

test('fixed export metadata and input ordering produce stable output without mutating the report',()=>{
  const report=fixture(),original=JSON.stringify(report);const first=reportMarkdown(report,options);assert.equal(reportMarkdown(report,options),first);assert.equal(JSON.stringify(report),original);
  const empty=reportMarkdown({},options);assert.match(empty,/No actions were recorded/);assert.match(empty,/Unknown/);assert.doesNotMatch(empty,/undefined|NaN/);
});

test('malformed graph, missing usage and unknown file states remain unknown rather than successful zeroes',()=>{
  const report=fixture();report.graph=null;report.model_usage={};delete report.model_calls;report.captures[0].status=null;
  const summary=reportSummary(report),markdown=reportMarkdown(report,options);assert.equal(summary.usage.attempts,null);assert.equal(summary.usage.incompleteUsageAttempts,null);assert.equal(summary.usage.costUsd,null);assert.equal(summary.evidence.unknown,1);assert.equal(summary.evidence.pending,0);
  assert.match(markdown,/States recorded:\*\* Unknown/);assert.match(markdown,/Transitions recorded:\*\* Unknown/);assert.match(markdown,/Provider attempts \| Unknown/);assert.match(markdown,/Incomplete usage attempts \| Unknown/);assert.match(markdown,/Unknown evidence states \| 1/);assert.equal(find(reportEvidence(report),'capture',3).status,'unknown');
});

test('malformed enum keys cannot use object prototypes and orphan available captures cannot be downloaded',()=>{
  const report=fixture();report.actions[0].state='__proto__';report.actions[0].assessment.verdict='constructor';let summary=reportSummary(report);assert.equal(summary.actions.states.__proto__,1);assert.equal(summary.actions.verdicts.constructor,1);
  report.captures.push(capture(66,'after',{action_id:id(99)}));let row=find(reportEvidence(report),'capture',66);assert.equal(row.status,'invalid');assert.equal(row.path,null);assert.equal(row.endpoint,null);
  report.captures.at(-1).status='failed';row=find(reportEvidence(report),'capture',66);assert.equal(row.status,'failed');
});

test('review and automatic-check text stays escaped and tokenless in both report modes',()=>{
  const report=fixture(),attack='[claim](javascript:bad) <img src=https://evil.test/leak> ![pixel](https://evil.test/x)';
  report.finding_reviews=[{run_id:runId,action_id:actionId,review_id:id(50),revision:1,disposition:'needs_review',rationale:attack,expectation_basis:attack,reviewer_id:attack}];report.automatic_reproductions=[{task_id:id(80),source_action_id:actionId,status:'pending',reason:attack,planned_actions:2}];
  report.actions[0].spec.private_login_password='SHOULD_NOT_APPEAR';report.run.config.session_secret='SHOULD_NOT_APPEAR';
  for(const bundle of [false,true]){const markdown=reportMarkdown(report,{...options,bundle,evidence:[]});assert.doesNotMatch(markdown,/<img|https:\/\/|javascript:|SHOULD_NOT_APPEAR/);assert.match(markdown,/&lt;img/);assert.match(markdown,/\\\[claim\\\]/);}
});

test('exported focus history preserves command and decision references without turning instructions into markup',()=>{
  const report=fixture();report.steering={revision:2,messages:[{revision:1,focus:'<script>run()</script>',status:'applied',steering_id:id(70),decision_id:id(71)},{revision:2,focus:'',status:'not_applied',steering_id:id(72),decision_id:null}]};
  const md=reportMarkdown(report,options);assert.match(md,/## Testing focus/);assert.ok(md.includes(id(70)));assert.ok(md.includes(id(71)));assert.ok(md.includes('not'+String.fromCharCode(92)+'_applied'));assert.doesNotMatch(md,/<script>/);assert.match(md,/Restore normal exploration/);
});
