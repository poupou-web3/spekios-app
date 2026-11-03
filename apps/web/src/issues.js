import {showAgentHandoff,closeAgentHandoff} from './agent-handoff.js';
import {signIn,workspaceRequest,requireOk} from '/assets/ui/http.js';
import {mountThemeSwitch} from '/assets/ui/theme.js';
import {mountWebsitePage,prepareWebsitePage} from './website-page.js';
prepareWebsitePage('issues');
const $=selector=>document.querySelector(selector);
// The header theme control is the only shared widget on this page.
const themeSlot=$('[data-theme-slot]');if(themeSlot)mountThemeSwitch(themeSlot);
const make=(tag,text,className)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(className)n.className=className;return n;};
let token=sessionStorage.getItem('scout.workspace-token')||'',development=false,spekios=false,identity=null,detail=null,issueId='',offset=0,nextOffset=null,busy=false,selectedVerification='',draft=null,timer,pageLimit=5;
let previousOffsets=[];
let listSnapshot='',listVersion=0,detailVersion=0;
let issueWebsitePage=null;
const images=new Set();let imageGeneration=0;
const uuid=value=>/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value||'');
const message=text=>{$('#issue-status').textContent=text;};
const labels={resolved:'Resolved on candidate',still_reproducible:'Still reproducible',blocked:'Blocked',inconclusive:'Inconclusive',queued:'Queued',running:'Running',unverified:'Not checked yet'};
function outcome(check){return check?.outcome||check?.status||'unverified';}
function badge(check){const key=outcome(check);return make('span',labels[key]||key,`pill ${key==='resolved'?'green':key==='still_reproducible'?'red':''}`);}
const triageLabels={untriaged:'New',needs_review:'Needs review',bug:'Bug',intended_behavior:'Intended behavior',duplicate:'Duplicate'};
const deciders={human:'a person',agent:'an agent',system:'Spekios, matching a known issue'};
function trackingBadge(issue){
  if(issue.tracking?.status==='observed_again')return make('span','Observed again','pill amber');
  return badge(issue.latest_verification);
}
const activityLabels={'issue.discovered':'First discovered','issue.observed_again':'Observed again in a run','issue.reviewed':'Human review recorded','issue.triaged':'Triage decision recorded','verification.queued':'Candidate check queued','verification.started':'Candidate check started','verification.finished':'Candidate check finished'};
function triageBadge(issue){const key=issue.triage_status||'untriaged';return make('span',triageLabels[key]||key,`pill ${key==='bug'?'red':key==='intended_behavior'||key==='duplicate'?'green':''}`);}
function link(text,path,className='button quiet'){const n=make('a',text,className);n.href=path;return n;}
function stamp(value){return value?new Date(value).toLocaleString():'Not recorded';}
async function api(path,body){
  const currentToken=token;
  try{
    const response=await workspaceRequest(path,{token:currentToken,body,timeoutMs:20000});
    await requireOk(response);const value=await response.json();
    if(currentToken!==token)throw new Error('Workspace disconnected.');
    return value;
  }catch(e){
    if(currentToken!==token)throw new Error('Workspace disconnected.');
    if(e.status===401){closeAgentHandoff();if(spekios){location.assign('/login?next=%2Fissues');throw e;}clearInterval(timer);detailVersion++;listVersion++;releaseImages();$('#issue-login').hidden=false;$('#issue-workspace').hidden=true;}
    throw e;
  }
}
function usage(value){
  if(!value)return 'Usage not available yet.';
  const amount=(v)=>v===null||v===undefined?'unknown':Number(v).toLocaleString();
  return `${amount(value.attempts)} model calls · reported tokens: ${amount(value.known_input_tokens)} in / ${amount(value.known_output_tokens)} out / ${amount(value.known_total_tokens??(value.known_input_tokens==null&&value.known_output_tokens==null?null:Number(value.known_input_tokens??0)+Number(value.known_output_tokens??0)))} total · reported cost: ${value.provider_reported_cost_usd==null?'unknown':'$'+value.provider_reported_cost_usd} · ${amount(value.incomplete_usage_attempts)} incomplete usage / ${amount(value.unpriced_attempts)} unpriced calls${value.pending_requests?' · usage still pending':''}`;
}
function releaseImages(){imageGeneration++;for(const url of images)URL.revokeObjectURL(url);images.clear();}
async function screenshot(root,id,label,generation){
  const box=make('figure',undefined,'issue-frame');box.append(make('figcaption',label));root.append(box);
  if(!uuid(id)){box.append(make('p','No recorded screenshot for this step.','small muted'));return;}
  box.append(make('code',id,'small'));
  try{
    const currentToken=token;
    const response=await workspaceRequest(`/v1/captures/${id}/image`,{token:currentToken,timeoutMs:15000});
    if(!response.ok)throw new Error('Evidence unavailable');
    const blob=await response.blob();if(generation!==imageGeneration||currentToken!==token)return;
    const url=URL.createObjectURL(blob);images.add(url);const img=make('img');img.src=url;img.alt=label;img.loading='lazy';box.append(img);
  }catch{if(generation===imageGeneration)box.append(make('p','Evidence could not be loaded. Open the recorded run to inspect its status.','small muted'));}
}
function evidence(root,ids,title){const row=make('div',undefined,'issue-evidence');root.append(make('h3',title),row);const generation=imageGeneration;void screenshot(row,ids?.[0],'Before action',generation);void screenshot(row,ids?.[1],'After action',generation);}
async function copyHandoff(){
  if(!detail)return;
  try{showAgentHandoff(detail.handoff,{title:detail.issue.title,revision:detail.issue.revision});}catch(e){message(e.message);}
}

async function list(){
  const version=++listVersion;
  const params=new URLSearchParams({offset:String(offset),limit:'20'});const query=$('#issue-query').value.trim(),filter=$('#issue-outcome').value,triage=$('#issue-triage').value;if(query)params.set('query',query);if(filter)params.set('outcome',filter);if(triage)params.set('triage',triage);
  if(issueWebsitePage?.origin)params.set('origin',issueWebsitePage.origin);
  const page=await api('/v1/issues?'+params);if(version!==listVersion)return;nextOffset=page.next_offset;$('#issue-total').textContent=String(page.total);$('#issue-prev').disabled=offset===0;$('#issue-next').disabled=nextOffset===null;
  const snapshot=JSON.stringify({page,issueId});if(snapshot===listSnapshot)return;listSnapshot=snapshot;
  const root=$('#issue-list');root.replaceChildren();
  if(!page.issues.length)root.append(make('p',page.total?'No issues on this page.':'No issues match this view. Start an exploration to discover behavior worth checking.','issue-empty small muted'));
  for(const issue of page.issues){const a=link('',`/issues#${issue.issue_id}`,'issue-index-item');if(issue.issue_id===issueId)a.setAttribute('aria-current','true');a.append(trackingBadge(issue),triageBadge(issue),make('h3',issue.title),make('p',issue.source_target_url,'small muted'),make('code',issue.issue_id.slice(0,8),'small'));root.append(a);}
}
function renderOriginal(){
  const {issue,original,handoff}=detail,root=$('#issue-original');root.replaceChildren();
  const head=make('div',undefined,'issue-section-heading'),copy=make('button','Copy for a coding agent','button');copy.addEventListener('click',copyHandoff);head.append(make('span','ORIGINAL FINDING','eyebrow'),copy);root.append(head,make('h2',issue.title));
  const id=make('p',undefined,'small');id.append(make('span','Issue ID · '),make('code',issue.issue_id));root.append(id,make('p',issue.source_target_url,'small muted'),trackingBadge(issue));
  if(issue.tracking?.status==='observed_again')root.append(make('p','This behavior was observed in a later run. Earlier candidate check results remain in the history; they do not establish a fix on this run’s deployment.','small muted'));
  root.append(make('p',`Last observed ${stamp(issue.tracking?.last_observed_at||issue.last_seen_at)}`,'small muted'));
  if(issue.canonical_issue_id&&issue.canonical_issue_id!==issue.issue_id)root.append(link('Open the linked original issue',`/issues#${issue.canonical_issue_id}`));
  if(detail.execution_mode==='protocol_fixture')root.append(make('p','SIMULATED MODEL · browser and screenshots are real; this run tests the protocol.','tag'));
  const pair=make('div',undefined,'issue-behavior');for(const [label,value] of [['Expected',original.expected_result],['Actual',original.observed_result]]){const p=make('div');p.append(make('h3',label),make('p',value||'Not recorded'));pair.append(p);}root.append(pair);
  root.append(make('p',`${issue.viewport_profile||'Recorded viewport'} · First seen ${stamp(issue.first_seen_at)} · ${issue.occurrence_count} recorded occurrence(s)`,'small muted'));
  root.append(make('p',`Human review: ${handoff.human_review?.disposition||'not reviewed'}. The original model suspicion and each candidate result remain separate.`,'small muted'));
  const path=make('details',undefined,'issue-path');path.append(make('summary','Recorded reproduction steps'));const ol=make('ol');for(const step of handoff.reproduction?.recorded_steps||[]){const li=make('li');li.append(make('strong',step.command?.type||'Recorded action'),make('p',step.expected_result||'Expectation not recorded','small'));ol.append(li);}path.append(ol);root.append(path);
  root.append(link('Open original run & diagnostics',`/#/workspace/${issue.source_run_id}/${issue.source_action_id}`));
  evidence(root,[original.before_capture_id,original.after_capture_id],'Original evidence');
  const usageLine=make('p','Original exploration usage · '+usage(detail.usage.source_run),'small muted');usageLine.id='source-run-usage';root.append(usageLine);
}
function renderHistory(){
  const root=$('#verification-list');root.replaceChildren();
  if(!detail.verifications.items.length)root.append(make('p','No candidate checks yet. Submit a deployment URL above.','issue-empty small muted'));
  for(const check of detail.verifications.items){
    const article=make('article',undefined,'issue-check'),head=make('div',undefined,'issue-section-heading');head.append(badge(check),make('span',stamp(check.created_at),'small muted'));article.append(head,make('p',check.candidate_url,'issue-candidate-url'),make('code',check.verification_id,'small'));
    if(check.deployment_ref)article.append(make('p',check.deployment_ref,'small muted'));
    if(check.result?.reason)article.append(make('p',check.result.reason,'small'));
    article.append(make('p',usage(check.usage),'small muted'));
    const buttons=make('div',undefined,'row');if(check.run_id)buttons.append(link('Open candidate run',`/#/workspace/${check.run_id}`));
    if(check.result){const b=make('button',selectedVerification===check.verification_id?'Evidence selected':'Compare evidence','button');b.setAttribute('aria-pressed',String(selectedVerification===check.verification_id));b.addEventListener('click',()=>{selectedVerification=check.verification_id;releaseImages();renderOriginal();renderHistory();renderCandidate();});buttons.append(b);}
    if(['queued','running'].includes(check.job_status)){const b=make('button','Stop check','button');b.addEventListener('click',async()=>{b.disabled=true;try{await api(`/v1/browser-jobs/${check.job_id}/cancel`,{});message('Stopping check. An incomplete check cannot establish a fix.');await loadDetail(false);}catch(e){message(e.message);b.disabled=false;}});buttons.append(b);}
    article.append(buttons);root.append(article);
  }
  const occurrences=$('#issue-occurrences');occurrences.replaceChildren();
  for(const occurrence of detail.occurrences.items){
    const item=make('article',undefined,'issue-check');
    item.append(make('strong',stamp(occurrence.created_at)),make('p',occurrence.target_url||'Recorded run','small muted'));
    if(occurrence.expected_result)item.append(make('p','Expected: '+occurrence.expected_result,'small'));
    if(occurrence.observed_result)item.append(make('p','Observed: '+occurrence.observed_result,'small'));
    item.append(link('Open this occurrence',`/#/workspace/${occurrence.run_id}/${occurrence.action_id}`));occurrences.append(item);
  }
  if(!detail.occurrences.items.length)occurrences.append(make('p','No recorded occurrence on this page.','small muted'));
  const related=$('#issue-related');related.replaceChildren();
  for(const finding of detail.related_findings?.items||[]){
    const item=make('p',undefined,'issue-event small');item.append(make('strong',finding.relation==='linked_duplicate'?'Linked duplicate · ':'Same interface, separate finding · '),link(finding.title,`/issues#${finding.issue_id}`,''),trackingBadge(finding),make('span',' · Last observed '+stamp(finding.last_seen_at)));related.append(item);
  }
  if(!(detail.related_findings?.items||[]).length)related.append(make('p','No related findings recorded.','small muted'));
  const history=$('#issue-events');history.replaceChildren();for(const event of detail.history.items){const p=make('p',undefined,'issue-event small');p.append(make('strong',activityLabels[event.event_type]||event.event_type.replaceAll('.',' · ')),make('span',` · ${stamp(event.occurred_at)}${event.payload.outcome?' · '+(labels[event.payload.outcome]||event.payload.outcome):''}${event.payload.verification_id?' · check '+event.payload.verification_id.slice(0,8):''}${event.payload.disposition?' · '+event.payload.disposition:''}`));if(event.payload.run_id)p.append(link('Open run',`/#/workspace/${event.payload.run_id}`));history.append(p);}
  $('#history-more').hidden=!['verifications','history','occurrences'].some(key=>detail[key].pagination.next_offset!==null);
}
function renderCandidate(){
  const root=$('#candidate-evidence');root.replaceChildren();const check=detail.verifications.items.find(v=>v.verification_id===selectedVerification);if(!check?.result)return;
  root.append(make('h3','Selected candidate'),make('p',check.candidate_url,'small muted'),badge(check));
  const pair=make('div',undefined,'issue-behavior');for(const [label,value] of [['Frozen expectation',detail.original.expected_result],['Candidate actual',check.result.observed_result||check.result.reason]]){const p=make('div');p.append(make('h3',label),make('p',value||'Not recorded'));pair.append(p);}root.append(pair);
  evidence(root,check.result.candidate_capture_ids,'Candidate evidence');
  if(check.result.evidence_verified===false)root.append(make('p','The full evidence set could not be verified. This result cannot establish a fix.','small muted'));
}
// Triage edits survive background refreshes; a new issue starts from its current decision.
function renderTriage(reset){
  const t=detail.issue.triage,current=$('#triage-current');current.replaceChildren();
  if(!t)current.append(make('strong','Not triaged yet. '),make('span','Decide whether this is a bug, intended behavior or a duplicate. Agents can decide too; a person can always change it.'));
  else{current.append(make('strong',`${triageLabels[t.decision]||t.decision} · decided by ${deciders[t.actor]||t.actor} · ${stamp(t.created_at)}`),make('span',' — '+t.rationale));
    if(t.duplicate_of)current.append(make('span',' Duplicate of '),link(t.duplicate_of.slice(0,8),`/issues#${t.duplicate_of}`,'')); 
    if(t.matched_issue_id)current.append(make('span',' Matched '),link(t.matched_issue_id.slice(0,8),`/issues#${t.matched_issue_id}`,''));}
  if(reset){$('#triage-decision').value=t?.decision||'bug';$('#triage-duplicate').value=t?.duplicate_of||'';$('#triage-rationale').value='';$('#triage-error').textContent='';}
  showDuplicate();
}
function showDuplicate(){const duplicate=$('#triage-decision').value==='duplicate';$('#triage-duplicate').hidden=!duplicate;$('#triage-duplicate-label').hidden=!duplicate;$('#triage-duplicate').required=duplicate;}
async function submitTriage(event){
  event.preventDefault();if(busy||!detail||issueId!==location.hash.slice(1))return;$('#triage-error').textContent='';
  const id=issueId,decision=$('#triage-decision').value,rationale=$('#triage-rationale').value.trim(),duplicate=$('#triage-duplicate').value.trim();
  if(!rationale){$('#triage-error').textContent='Say why, so later readers and agents can rely on the decision.';return;}
  if(decision==='duplicate'&&(!uuid(duplicate)||duplicate===id)){$('#triage-error').textContent='Enter the full ID of the issue this one repeats.';return;}
  const body={decision,rationale,expected_revision:detail.issue.triage?.revision??0};if(decision==='duplicate')body.duplicate_of=duplicate;
  busy=true;$('#triage-submit').disabled=true;
  try{await api(`/v1/issues/${id}/triage`,body);if(issueId!==id)return;message('Decision saved. Later runs that reach the same page and control are labelled with it.');busy=false;await loadDetail(true);await list();}
  catch(e){if(issueId===id)$('#triage-error').textContent=e.code==='human_decision_present'?'A person already decided this issue.':e.code==='triage_revision_conflict'?'Someone changed this decision meanwhile. Review the current decision and try again.':'The decision was not saved: '+e.message+'.';}
  finally{busy=false;$('#triage-submit').disabled=false;}
}
// One recheck ID per submitted deployment; a retry after an uncertain response reuses it.
const recheckKey='scout.pending-recheck';let recheck=null;
function renderRecheck(value){
  const root=$('#recheck-result');root.replaceChildren();if(!value)return;const c=value.counts;
  root.append(make('p',`${value.complete?'Recheck finished':'Recheck running'} · ${value.candidate_origin}${value.deployment_ref?' · '+value.deployment_ref:''}`,'small'),
    make('p',`${c.selected} open issue(s) · ${c.resolved} resolved · ${c.still_reproducible} still reproducible · ${c.blocked} blocked · ${c.inconclusive} inconclusive · ${c.pending} pending${c.skipped?` · ${c.skipped} not checkable`:''}${value.omitted_issues?` · ${value.omitted_issues} more not included`:''}`,'small muted'));
  const ul=make('ul','', 'small');for(const item of value.items){const li=make('li');li.append(link(item.title||item.issue_id.slice(0,8),`/issues#${item.issue_id}`,''),make('span',' · '+(item.outcome?labels[item.outcome]||item.outcome:item.skipped_reason?'Not checkable: '+item.skipped_reason:item.status||'queued')));ul.append(li);}root.append(ul);
}
async function submitRecheck(event){
  event.preventDefault();$('#recheck-error').textContent='';
  let pending=null;try{pending=JSON.parse(sessionStorage.getItem(recheckKey)||'null');}catch{}
  if(!pending){
    const body={recheck_id:crypto.randomUUID(),candidate_url:$('#recheck-url').value.trim()};const source=$('#recheck-source').value.trim(),label=$('#recheck-ref').value.trim();
    try{const u=new URL(body.candidate_url);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw new Error();}catch{$('#recheck-error').textContent='Enter an HTTP or HTTPS deployment URL without sign-in details.';return;}
    if(source)body.source_origin=source;if(label)body.deployment_ref=label;pending=body;sessionStorage.setItem(recheckKey,JSON.stringify(pending));
  }
  $('#recheck-submit').disabled=true;
  try{recheck=await api('/v1/rechecks',pending);sessionStorage.removeItem(recheckKey);renderRecheck(recheck);message(recheck.counts.selected?'Recheck queued. Each open issue gets its own fresh-browser check.':'No open issues were found for that site.');}
  catch(e){$('#recheck-error').textContent=e.status>=500||e.message==='Connection lost'?'The recheck may not have started. Submit again to retry the same recheck.':'The recheck was not accepted: '+e.message+'.';if(e.status&&e.status<500)sessionStorage.removeItem(recheckKey);}
  finally{$('#recheck-submit').disabled=false;}
}
async function refreshRecheck(){if(!recheck||recheck.complete)return;recheck=await api(`/v1/rechecks/${recheck.recheck_id}`);renderRecheck(recheck);}
async function sessions(){
  const id=issueId,selected=draft?.issue_id===issueId?draft.session_id||'':$('#candidate-session').value,root=$('#candidate-session');root.replaceChildren();const first=make('option','Public access / matching saved source session');first.value='';root.append(first);
  try{const access=await api('/v1/browser-access');if(id!==issueId)return;for(const s of access.sessions||[]){if(s.revoked_at||new Date(s.expires_at)<=new Date())continue;const option=make('option',`${s.origin} · expires ${stamp(s.expires_at)}${s.execution_mode==='protocol_fixture'?' · test':''}`);option.value=s.session_id;option.dataset.origin=s.origin;root.append(option);}root.value=selected;}catch{/* Reading issues does not require private sign-in administration. */}
}
function freezeDraft(frozen){for(const id of ['candidate-url','deployment-ref','candidate-session'])$('#'+id).disabled=frozen;$('#verify-new').hidden=!frozen;$('#verify-submit').textContent=frozen?'Retry same check':'Verify fix';}
const pendingKey=id=>'scout.pending-verification.'+id;
function pendingDraft(id){
  // Migrate the former single slot without replacing another issue's retry ID.
  for(const key of [pendingKey(id),'scout.pending-verification']){
    try{const saved=JSON.parse(sessionStorage.getItem(key)||'null');if(saved?.issue_id!==id||!uuid(saved.verification_id))continue;
      if(key!==pendingKey(id)){sessionStorage.setItem(pendingKey(id),JSON.stringify(saved));sessionStorage.removeItem(key);}
      return saved;
    }catch{}
  }
  return null;
}
async function submit(event){
  event.preventDefault();if(busy||!detail||issueId!==location.hash.slice(1))return;$('#verify-error').textContent='';
  if(!draft){let candidate;try{candidate=new URL($('#candidate-url').value.trim());if(!['http:','https:'].includes(candidate.protocol)||candidate.username||candidate.password)throw new Error();}catch{$('#verify-error').textContent='Enter an HTTP or HTTPS candidate URL without credentials.';return;}
    draft={issue_id:issueId,verification_id:crypto.randomUUID(),candidate_url:candidate.href};const label=$('#deployment-ref').value.trim();if(label)draft.deployment_ref=label;const session=$('#candidate-session').value;if(session)draft.session_id=session;
    sessionStorage.setItem(pendingKey(issueId),JSON.stringify(draft));freezeDraft(true);
  }
  const submitted=draft;
  busy=true;$('#verify-submit').disabled=true;$('#verify-new').disabled=true;
  try{
    const {issue_id,...body}=submitted;const receipt=await api(`/v1/issues/${issue_id}/verifications`,body);
    if(sessionStorage.getItem(pendingKey(issue_id))===JSON.stringify(submitted))sessionStorage.removeItem(pendingKey(issue_id));
    if(issueId!==issue_id||location.hash.slice(1)!==issue_id)return;
    draft=null;freezeDraft(false);$('#verify-receipt').textContent=`Check ${receipt.verification_id} ${receipt.reused?'already exists':'queued'}. You can leave this page; Spekios keeps working.`;message('Candidate check submitted. Its outcome and usage will appear below.');await loadDetail(false);
  }catch(e){if(issueId===submitted.issue_id&&location.hash.slice(1)===submitted.issue_id)$('#verify-error').textContent=e.status===400||e.status===403?'This check was not accepted: '+e.message+'. Adjust the deployment or workspace access, then start a different check.':'Could not confirm submission: '+e.message+'. Retry the same check to avoid starting it twice.';}
  finally{busy=false;$('#verify-submit').disabled=false;$('#verify-new').disabled=false;}
}
async function loadDetail(reset=true){
  const version=++detailVersion,id=location.hash.slice(1),current=()=>version===detailVersion&&location.hash.slice(1)===id;
  if(!uuid(id)){issueId='';detail=null;releaseImages();$('#issue-empty').hidden=false;$('#issue-detail').hidden=true;return;}
  const changed=issueId!==id;if(changed){issueId=id;detail=null;pageLimit=5;selectedVerification='';releaseImages();$('#issue-detail').hidden=true;$('#issue-empty').hidden=false;$('#verify-receipt').textContent='';$('#verify-error').textContent='';$('#candidate-url').value='';$('#deployment-ref').value='';draft=null;freezeDraft(false);
    $('#candidate-session').value='';
    const saved=pendingDraft(id);if(saved){draft=saved;$('#candidate-url').value=saved.candidate_url;$('#deployment-ref').value=saved.deployment_ref||'';$('#candidate-session').value=saved.session_id||'';freezeDraft(true);}
  }
  let value;try{value=await api(`/v1/issues/${id}?limit=${pageLimit}`);}catch(e){if(!current())return;if(e.status!==413||pageLimit===1)throw e;pageLimit=1;value=await api(`/v1/issues/${id}?limit=1`);}if(!current())return;
  // A fresh snapshot replaces all history together. Never combine revisions.
  if(!reset&&detail&&detail.issue.revision===value.issue.revision){detail.usage=value.usage;const sourceUsage=$('#source-run-usage');if(sourceUsage)sourceUsage.textContent='Original exploration usage · '+usage(value.usage.source_run);let changed=false;for(const check of detail.verifications.items){const fresh=value.verifications.items.find(v=>v.verification_id===check.verification_id);if(fresh&&JSON.stringify(check)!==JSON.stringify(fresh)){Object.assign(check,fresh);changed=true;}}if(changed)renderHistory();return;}
  detail=value;if(issueWebsitePage?.selectForUrl(detail.issue.source_target_url)){offset=0;previousOffsets=[];listSnapshot='';$('#recheck-source').value=issueWebsitePage.origin;const scope=$('[data-website-scope]');if(scope)scope.textContent=issueWebsitePage.label();}releaseImages();$('#issue-empty').hidden=true;$('#issue-detail').hidden=false;if(!detail.verifications.items.some(v=>v.verification_id===selectedVerification))selectedVerification=detail.verifications.items.find(v=>v.result)?.verification_id||'';renderOriginal();renderTriage(changed);renderHistory();renderCandidate();if(changed)await sessions();
}
async function more(){
  if(!detail)return;
  const offsets=['verifications','history','occurrences'].map(key=>detail[key].pagination.next_offset).filter(v=>v!==null);if(!offsets.length)return;
  const revision=detail.issue.revision,id=issueId,version=detailVersion;
  try{const page=await api(`/v1/issues/${id}?limit=${pageLimit}&offset=${Math.min(...offsets)}&expected_revision=${revision}`);if(issueId!==id||version!==detailVersion||detail?.issue.revision!==revision)return;
    for(const key of ['verifications','history','occurrences']){const idKey=key==='verifications'?'verification_id':key==='history'?'event_id':'action_id';const items=new Map(detail[key].items.map(item=>[item[idKey],item]));for(const item of page[key].items)items.set(item[idKey],item);detail[key]={...page[key],items:[...items.values()]};}renderHistory();
  }catch(e){if(issueId!==id||version!==detailVersion)return;if(e.status===409){message('Issue history changed. Loaded a fresh snapshot; load more again for earlier entries.');await loadDetail();}else message(e.message);}
}
async function refresh(){if(busy||document.hidden)return;busy=true;try{await loadDetail(false);await list();await refreshRecheck();}catch(e){message('Refresh interrupted: '+e.message+'. The last available view is retained.');}finally{busy=false;}}
async function ready(){try{identity=await api('/v1/identity');if(!issueWebsitePage)issueWebsitePage=await mountWebsitePage({page:'issues',request:api,identity,mode:{development,spekios}});if(issueWebsitePage?.origin){$('#recheck-source').value=issueWebsitePage.origin;const scope=$('[data-website-scope]');if(scope)scope.textContent=issueWebsitePage.label();}$('#issue-login').hidden=true;$('#issue-workspace').hidden=false;await loadDetail();await list();message((issueWebsitePage?.origin?issueWebsitePage.label()+' · ':'Workspace issues · ')+'Original evidence and candidate checks stay private to your team.');clearInterval(timer);timer=setInterval(refresh,5000);}catch(e){message(e.message);if(e.status===401){closeAgentHandoff();if(spekios){location.assign('/login?next=%2Fissues');throw e;}$('#issue-login').hidden=false;$('#issue-workspace').hidden=true;}}}
$('#issue-login-form').addEventListener('submit',async e=>{e.preventDefault();const email=$('#issue-email').value.trim(),password=$('#issue-password').value;$('#issue-password').value='';try{await signIn(email,password);token=password;sessionStorage.setItem('scout.workspace-token',token);await ready();}catch(error){message(error.message);}});
$('#issue-filter').addEventListener('submit',async e=>{e.preventDefault();offset=0;previousOffsets=[];try{await list();}catch(e){message(e.message);}});
$('#issue-prev').addEventListener('click',async()=>{offset=previousOffsets.pop()??0;await list().catch(e=>message(e.message));});
$('#issue-next').addEventListener('click',async()=>{if(nextOffset===null)return;previousOffsets.push(offset);offset=nextOffset;await list().catch(e=>message(e.message));});
$('#verify-form').addEventListener('submit',submit);
$('#triage-form').addEventListener('submit',submitTriage);$('#triage-decision').addEventListener('change',showDuplicate);$('#recheck-form').addEventListener('submit',submitRecheck);
$('#verify-new').addEventListener('click',()=>{if(busy)return;draft=null;sessionStorage.removeItem(pendingKey(issueId));freezeDraft(false);$('#verify-error').textContent='';});
$('#refresh-sessions').addEventListener('click',sessions);$('#issue-refresh').addEventListener('click',refresh);$('#history-more').addEventListener('click',more);
window.addEventListener('hashchange',async()=>{await loadDetail().then(list).catch(e=>message(e.message));});window.addEventListener('pagehide',releaseImages);
$('.skip-link').addEventListener('click',event=>{event.preventDefault();$('#main-content').focus();$('#main-content').scrollIntoView({block:'start'});});
async function start(){try{const mode=(await (await fetch('/v1/auth-mode',{redirect:'error'})).json()).mode;development=mode==='local_development';spekios=mode==='spekios';if(development||spekios)token='';if(token||development||spekios)await ready();else $('#issue-login').hidden=false;}catch(e){message(e.message);}}
await start();
