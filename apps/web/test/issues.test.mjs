import {appSource} from './support.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const issue='11111111-1111-4111-8111-111111111111',verification='22222222-2222-4222-8222-222222222222',capture='33333333-3333-4333-8333-333333333333';
function fixture(){return {issue:{issue_id:issue,title:'<img src=x onerror=bad()>',source_target_url:'https://app.example/editor',source_run_id:issue,source_action_id:issue,revision:1,occurrence_count:1},original:{expected_result:'Saved is visible',observed_result:'Ready remains',before_capture_id:capture,after_capture_id:capture},handoff:{reproduction:{recorded_steps:[{command:{type:'click'},expected_result:'Saved'}]}},usage:{source_run:{attempts:2,known_input_tokens:null,known_output_tokens:3,provider_reported_cost_usd:null,incomplete_usage_attempts:1,unpriced_attempts:2}},verifications:{items:[{verification_id:verification,candidate_url:'https://preview.example/editor',outcome:'inconclusive',status:'completed',job_status:'completed',result:{reason:'Different result',observed_result:'Offline'},usage:{attempts:1}}],pagination:{next_offset:null}},history:{items:[],pagination:{next_offset:null}},occurrences:{items:[],pagination:{next_offset:null}}};}
function setup({value=fixture(),pending=null,failFirst=false,hash='#'+issue,intercept}={}){
  const nodes=new Map(),requests=[],copied=[],events={},storage=new Map([['scout.workspace-token','fixture-manager']]);if(pending)storage.set('scout.pending-verification',JSON.stringify(pending));let submissions=0;
  const node=()=>({value:'',textContent:'',hidden:false,disabled:false,children:[],dataset:{},handlers:{},attributes:{},append(...items){this.children.push(...items)},replaceChildren(...items){this.children=[...items]},setAttribute(k,v){this.attributes[k]=v},addEventListener(k,v){this.handlers[k]=v}});
  const get=key=>{if(!nodes.has(key))nodes.set(key,node());return nodes.get(key);};
  const NativeURL=URL;class TestURL extends NativeURL{}TestURL.createObjectURL=()=> 'blob:fixture';TestURL.revokeObjectURL=()=>{};
  const context={document:{querySelector:get,createElement:node,hidden:false},location:{hash},sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},navigator:{clipboard:{writeText:async text=>copied.push(text)}},window:{addEventListener:(k,v)=>events[k]=v},crypto:{randomUUID:()=>verification},URL:TestURL,URLSearchParams,AbortSignal,Date,Blob,setInterval:()=>1,clearInterval(){},fetch:async(path,options={})=>{
    requests.push({path,options});let body;
    if(options.method==='POST'&&path.endsWith('/verifications')){submissions++;if(failFirst&&submissions===1)throw new Error('Connection lost');body={verification_id:verification,reused:submissions>1};}
    else if(path==='/v1/identity')body={principal_kind:'workspace_manager'};
    else if(path==='/v1/browser-access')body={sessions:[]};
    else if(path.startsWith('/v1/issues?'))body={issues:[value.issue],total:1,next_offset:null};
    else body=structuredClone(value);
    return await intercept?.(path,options,body)??{ok:true,status:200,json:async()=>body,blob:async()=>new Blob(['fake-png'])};
  }};
  vm.createContext(context);const source=appSource('issues.js').replace('await start();','');vm.runInContext(source+'\nglobalThis.testing={ready,usage,submit,more,refresh,loadDetail,copyHandoff,outcome,submitTriage,submitRecheck,renderRecheck};',context);
  return {get,requests,copied,storage,events,ui:context.testing,location:context.location};
}
const text=node=>[node.textContent,...node.children.map(c=>typeof c==='string'?c:text(c))].join(' ');
test('issue page renders untrusted expectations and app titles as text, with separate original and candidate evidence',async()=>{
  const u=setup();await u.ui.ready();assert.ok(text(u.get('#issue-original')).includes('<img src=x onerror=bad()>'));assert.ok(text(u.get('#issue-original')).includes('Saved is visible'));assert.ok(text(u.get('#candidate-evidence')).includes('Offline'));assert.ok(text(u.get('#verification-list')).includes('Inconclusive'));assert.equal(text(u.get('#verification-list')).includes('Resolved on candidate'),false);
  assert.ok(u.requests.some(r=>r.path==='/v1/captures/'+capture+'/image'&&r.options.headers.Authorization==='Bearer fixture-manager'));assert.equal(u.requests.some(r=>r.path.includes('fixture-manager')),false);
  const source=appSource('issues.js').split('// apps/web/src/issues.js').at(-1);assert.doesNotMatch(source,/\.innerHTML|eval\(/);
});
test('a loaded issue starts no model or browser work and copies stable IDs for the coding agent',async()=>{
  const u=setup();await u.ui.ready();assert.equal(u.requests.some(r=>r.options.method==='POST'),false);await u.ui.copyHandoff();assert.match(u.copied[0],new RegExp(issue));assert.match(u.copied[0],/scout_verify_fix/);assert.match(u.copied[0],/Expected: Saved is visible/);assert.match(u.copied[0],/Actual: Ready remains/);assert.doesNotMatch(u.copied[0],/fixture-manager/);
});
test('unknown token and price reports remain unknown',()=>{
  const u=setup(),value=u.ui.usage({attempts:1,known_input_tokens:null,known_output_tokens:4,provider_reported_cost_usd:null,incomplete_usage_attempts:1,unpriced_attempts:1});assert.match(value,/unknown in/);assert.match(value,/cost: unknown/);assert.match(value,/1 incomplete usage/);assert.doesNotMatch(value,/\$0/);
});
test('uncertain admission persists a frozen UUID and retries the same candidate even if fields change',async()=>{
  const u=setup({failFirst:true});await u.ui.ready();u.get('#candidate-url').value='https://preview.example/editor';u.get('#deployment-ref').value='Preview 42';await u.ui.submit({preventDefault(){}});
  assert.ok(u.storage.has('scout.pending-verification.'+issue));assert.equal(u.get('#candidate-url').disabled,true);assert.match(u.get('#verify-error').textContent,/Retry the same check/);
  u.get('#candidate-url').value='https://changed.example/';await u.ui.submit({preventDefault(){}});const writes=u.requests.filter(r=>r.options.method==='POST');assert.equal(writes.length,2);assert.equal(writes[0].options.body,writes[1].options.body);assert.equal(JSON.parse(writes[1].options.body).verification_id,verification);assert.equal(u.storage.has('scout.pending-verification.'+issue),false);assert.equal(u.get('#candidate-url').disabled,false);
});
test('reload recovers only the pending check for the selected issue',async()=>{
  const draft={issue_id:issue,verification_id:verification,candidate_url:'https://preview.example/recover',deployment_ref:'Recovery'};const u=setup({pending:draft});await u.ui.ready();assert.equal(u.get('#candidate-url').value,draft.candidate_url);assert.equal(u.get('#candidate-url').disabled,true);assert.equal(u.requests.some(r=>r.options.method==='POST'),false);
  const other=setup({pending:{...draft,issue_id:verification}});await other.ui.ready();assert.equal(other.get('#candidate-url').disabled,false);
});
test('candidate URLs cannot contain login credentials or executable protocols',async()=>{
  for(const url of ['javascript:alert(1)','https://name:password@preview.example/']){const u=setup();await u.ui.ready();u.get('#candidate-url').value=url;await u.ui.submit({preventDefault(){}});assert.match(u.get('#verify-error').textContent,/without credentials/);assert.equal(u.requests.some(r=>r.options.method==='POST'),false);}
});
test('background refresh preserves candidate edits and does not submit them',async()=>{
  const u=setup();await u.ui.ready();u.get('#candidate-url').value='https://preview.example/edited';u.get('#deployment-ref').value='Work in progress';await u.ui.refresh();assert.equal(u.get('#candidate-url').value,'https://preview.example/edited');assert.equal(u.get('#deployment-ref').value,'Work in progress');assert.equal(u.requests.some(r=>r.options.method==='POST'),false);
});
test('idle polling keeps existing evidence controls mounted while a person reviews history',async()=>{
  const u=setup();await u.ui.ready();const control=u.get('#verification-list').children[0],issueLink=u.get('#issue-list').children[0];await u.ui.refresh();assert.equal(u.get('#verification-list').children[0],control);assert.equal(u.get('#issue-list').children[0],issueLink);
});
test('a completed check without an authoritative outcome is never labelled resolved',()=>{
  const u=setup();assert.equal(u.ui.outcome({status:'completed',job_status:'completed',verdict:'no_issue_observed'}),'completed');assert.equal(u.ui.outcome({outcome:'still_reproducible',status:'completed'}),'still_reproducible');
});

const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
test('navigation during a refresh immediately binds the new issue and rejects the old response',async()=>{
  let hold=false;const pending=deferred(),entered=deferred();const next=fixture();next.issue.issue_id=verification;next.issue.title='Second issue';
  const u=setup({intercept:(path)=>{
    if(hold&&path.startsWith(`/v1/issues/${issue}?`)){entered.resolve();return pending.promise;}
    if(path.startsWith(`/v1/issues/${verification}?`))return {ok:true,json:async()=>next};
  }});await u.ui.ready();hold=true;const refreshing=u.ui.refresh();await entered.promise;
  u.location.hash='#'+verification;await u.events.hashchange();
  assert.match(text(u.get('#issue-original')),/Second issue/);
  pending.resolve({ok:true,json:async()=>fixture()});await refreshing;
  assert.match(text(u.get('#issue-original')),/Second issue/);
  u.get('#candidate-url').value='https://preview.example/editor';await u.ui.submit({preventDefault(){}});
  assert.equal(u.requests.find(r=>r.options.method==='POST').path,`/v1/issues/${verification}/verifications`);
});
test('a response from an older same-issue refresh cannot overwrite newer history',async()=>{
  let hold=false;const pending=deferred(),entered=deferred();let calls=0;const newer=fixture();newer.issue.revision=2;newer.issue.title='Latest issue history';
  const u=setup({intercept:(path)=>{
    if(!hold||!path.startsWith(`/v1/issues/${issue}?`))return;
    if(++calls===1){entered.resolve();return pending.promise;}
    return {ok:true,json:async()=>newer};
  }});await u.ui.ready();hold=true;const first=u.ui.loadDetail();await entered.promise;await u.ui.loadDetail();pending.resolve({ok:true,json:async()=>fixture()});await first;
  assert.match(text(u.get('#issue-original')),/Latest issue history/);
});
test('a completed submission stays bound to its issue after navigation and preserves the new candidate edits',async()=>{
  const pending=deferred(),entered=deferred(),next=fixture();next.issue.issue_id=verification;next.issue.title='Second issue';
  const u=setup({intercept:(path,options)=>{
    if(options.method==='POST'){entered.resolve();return pending.promise;}
    if(path.startsWith(`/v1/issues/${verification}?`))return {ok:true,json:async()=>next};
  }});await u.ui.ready();u.get('#candidate-url').value='https://preview.example/first';const submitting=u.ui.submit({preventDefault(){}});await entered.promise;
  await u.get('#verify-new').handlers.click();assert.ok(u.storage.has('scout.pending-verification.'+issue),'An in-flight command must retain its retry ID');
  u.location.hash='#'+verification;await u.events.hashchange();u.get('#candidate-url').value='https://preview.example/second';pending.resolve({ok:true,json:async()=>({verification_id:verification})});await submitting;
  assert.match(text(u.get('#issue-original')),/Second issue/);assert.equal(u.get('#candidate-url').value,'https://preview.example/second');assert.equal(u.get('#verify-receipt').textContent,'');assert.equal(u.requests.filter(r=>r.options.method==='POST').length,1);
});
test('an older issue search response cannot replace the current filter result',async()=>{
  const pending=deferred(),entered=deferred();let hold=false;const u=setup({intercept:path=>{
    if(hold&&path.includes('query=old')){entered.resolve();return pending.promise;}
    if(path.includes('query=new'))return {ok:true,json:async()=>({issues:[],total:0,next_offset:null})};
  }});await u.ui.ready();hold=true;u.get('#issue-query').value='old';const first=u.get('#issue-filter').handlers.submit({preventDefault(){}});await entered.promise;
  u.get('#issue-query').value='new';await u.get('#issue-filter').handlers.submit({preventDefault(){}});pending.resolve({ok:true,json:async()=>({issues:[fixture().issue],total:1,next_offset:null})});await first;
  assert.equal(u.get('#issue-total').textContent,'0');assert.match(text(u.get('#issue-list')),/No issues match/);
});
test('an uncertain check keeps its retry ID when another issue submits a candidate',async()=>{
  const next=fixture();next.issue.issue_id=verification;next.issue.title='Second issue';
  const u=setup({failFirst:true,intercept:path=>path.startsWith(`/v1/issues/${verification}?`)?{ok:true,json:async()=>next}:undefined});await u.ui.ready();
  u.get('#candidate-url').value='https://preview.example/uncertain';await u.ui.submit({preventDefault(){}});
  const original=u.requests.find(r=>r.options.method==='POST').options.body;
  u.location.hash='#'+verification;await u.events.hashchange();u.get('#candidate-url').value='https://preview.example/second';await u.ui.submit({preventDefault(){}});
  u.location.hash='#'+issue;await u.events.hashchange();assert.equal(u.get('#candidate-url').value,'https://preview.example/uncertain');assert.equal(u.get('#candidate-url').disabled,true);
  await u.ui.submit({preventDefault(){}});const attempts=u.requests.filter(r=>r.options.method==='POST'&&r.path===`/v1/issues/${issue}/verifications`);assert.equal(attempts[1].options.body,original);
});

test('a person triages with the revision they saw, and a duplicate needs the full issue ID',async()=>{
  const u=setup();await u.ui.ready();assert.match(text(u.get('#triage-current')),/Not triaged yet/);
  u.get('#triage-decision').value='duplicate';u.get('#triage-rationale').value='Same failure as the cart issue.';u.get('#triage-duplicate').value='2222';
  await u.ui.submitTriage({preventDefault(){}});assert.match(u.get('#triage-error').textContent,/full ID/);assert.equal(u.requests.some(r=>r.path.endsWith('/triage')),false);
  u.get('#triage-decision').value='intended_behavior';u.get('#triage-rationale').value='  The editor autosaves; no banner is shown by design.  ';
  await u.ui.submitTriage({preventDefault(){}});const write=u.requests.find(r=>r.path===`/v1/issues/${issue}/triage`);assert.ok(write);
  assert.deepEqual(JSON.parse(write.options.body),{decision:'intended_behavior',rationale:'The editor autosaves; no banner is shown by design.',expected_revision:0});
});
test('known behavior is labelled with who decided it, and the list defaults to open issues',async()=>{
  const value=fixture();value.issue.triage={decision:'intended_behavior',actor:'agent',rationale:'Matches the spec.',revision:2,created_at:'2026-10-31T10:00:00Z'};value.issue.triage_status='intended_behavior';
  const u=setup({value});u.get('#issue-triage').value='open';await u.ui.ready();assert.match(text(u.get('#triage-current')),/Intended behavior · decided by an agent/);
  assert.ok(u.requests.some(r=>r.path.startsWith('/v1/issues?')&&r.path.includes('triage=open')));assert.match(text(u.get('#issue-list')),/Intended behavior/);
  assert.equal(u.get('#triage-decision').value,'intended_behavior');
});
test('a person cannot be overruled silently: conflicts explain the current decision',async()=>{
  const u=setup({intercept:(path,options)=>path.endsWith('/triage')?{ok:false,status:409,json:async()=>({error:'human_decision_present'})}:undefined});await u.ui.ready();
  u.get('#triage-decision').value='bug';u.get('#triage-rationale').value='Reproduced twice.';await u.ui.submitTriage({preventDefault(){}});assert.equal(u.get('#triage-error').textContent,'A person already decided this issue.');
});
test('a deployment recheck keeps its ID until the receipt arrives, then shows each issue outcome',async()=>{
  let attempts=0;const receipt={recheck_id:'44444444-4444-4444-8444-444444444444',candidate_origin:'https://preview.example',deployment_ref:'Release 2',complete:false,omitted_issues:0,
    counts:{selected:1,admitted:1,skipped:0,pending:1,resolved:0,still_reproducible:0,blocked:0,inconclusive:0},items:[{issue_id:issue,title:'Save fails',status:'queued',outcome:null}]};
  const u=setup({intercept:(path,options)=>path==='/v1/rechecks'?(++attempts===1?(()=>{throw new Error('Connection lost');})():{ok:true,status:202,json:async()=>receipt}):undefined});await u.ui.ready();
  u.get('#recheck-url').value='https://preview.example/';u.get('#recheck-ref').value='Release 2';await u.ui.submitRecheck({preventDefault(){}});
  assert.ok(u.storage.has('scout.pending-recheck'));assert.match(u.get('#recheck-error').textContent,/retry the same recheck/);
  u.get('#recheck-url').value='https://other.example/';await u.ui.submitRecheck({preventDefault(){}});
  const writes=u.requests.filter(r=>r.path==='/v1/rechecks');assert.equal(writes.length,2);assert.equal(writes[0].options.body,writes[1].options.body);
  assert.equal(u.storage.has('scout.pending-recheck'),false);assert.match(text(u.get('#recheck-result')),/1 open issue\(s\) · 0 resolved/);assert.match(text(u.get('#recheck-result')),/Save fails/);
});
