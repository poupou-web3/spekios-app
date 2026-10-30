// Testing focus: versioned steering requests for an active exploration.
import {date,esc,number,short} from '/assets/ui/format.js';
import {api,get} from '../api.js';
import {render} from '../app.js';
import {state,steeringDrafts} from '../state.js';
export function mergeSteering(next,previous){
  if(!next)return previous;
  if(!previous)return next;
  if(next.revision<previous.revision)return previous;
  const messages=new Map(previous.messages.map(item=>[item.steering_id,item]));
  for(const item of next.messages){const saved=messages.get(item.steering_id);if(!saved||saved.status==='pending'||item.status!=='pending')messages.set(item.steering_id,item);}
  return {...next,messages:[...messages.values()].sort((a,b)=>a.revision-b.revision)};
}
export function steeringDraft(id=state.runId){
  let draft=steeringDrafts.get(id);
  const snapshot=state.report?.run.run_id===id?state.report.steering:null;
  const latest=snapshot?.messages.at(-1);
  if(!draft){
    let command=null;
    try{const saved=JSON.parse(sessionStorage.getItem('scout.pending-focus.'+id));if(saved?.steering_id&&Number.isInteger(saved.expected_revision)&&typeof saved.focus==='string')command=saved;}catch{}
    draft={focus:command?.focus??latest?.focus??'',revision:command?.expected_revision??snapshot?.revision??0,command,busy:false,dirty:!!command,error:'',message:''};steeringDrafts.set(id,draft);
  }else if(!draft.dirty&&!draft.busy&&!draft.command){draft.focus=latest?.focus??'';draft.revision=snapshot?.revision??0;}
  return draft;
}
export function updateSteeringFocus(value){
  const draft=steeringDraft();if(draft.busy||draft.command)return false;
  draft.focus=value;draft.dirty=true;draft.error='';draft.message='';return true;
}
export function steeringPanel(){
  const report=state.report,run=report?.run;
  if(!run||run.config.runtime_version!=='explorer-v1'||run.config.replay_of)return '';
  const snapshot=report.steering||{revision:0,messages:[]},draft=steeringDraft(),latest=snapshot.messages.at(-1);
  const applied=snapshot.active_focus||snapshot.messages.filter(m=>m.status==='applied').at(-1),active=run.lifecycle==='active'&&!run.cancel_requested_at;
  const labels={pending:'Waiting for next plan',applied:'Applied to planning',superseded:'Replaced before application',not_applied:'Not applied'};
  const conflict=draft.revision!==snapshot.revision&&!draft.command;
  return `<section class="panel steering-panel"><div class="panel-header"><div><h2>Testing focus</h2><p class="small muted">${applied?.focus?esc(applied.focus):'Explore likely user journeys'}</p></div>${latest?`<span class="pill ${latest.status==='applied'?'green':latest.status==='pending'?'blue':''}">${esc(labels[latest.status])}</span>`:''}</div><div class="steering-body"><p class="small muted">Change what Scout explores next. Focus applies at the next planning decision after the current action is assessed. Clearing it restores normal exploration.</p>${active||draft.command?`<form id="steering-form" data-run-id="${esc(run.run_id)}"><label for="steering-focus">What should Scout focus on?</label><textarea id="steering-focus" maxlength="2000" rows="2" placeholder="For example: focus on search, filtering, and opening a result" ${draft.busy||draft.command?'readonly':''}>${esc(draft.focus)}</textarea><p class="small muted">Existing action limits and access rules still apply. Keep credentials in the private sign-in window.</p>${conflict?'<p class="notice" role="status">The focus changed elsewhere. Review its history, then keep your edits or use the latest focus.</p>':''}${draft.error?`<p class="review-error" role="alert">${esc(draft.error)}</p>`:''}<div class="configuration-actions"><button type="submit" class="button primary" ${draft.busy||!draft.dirty||conflict||draft.focus.length>2000?'disabled':''}>${draft.busy?'Sending…':draft.command?'Retry same request':'Update focus'}</button>${!draft.command?`<button type="button" class="button" data-action="reset-steering" ${draft.busy?'disabled':''}>Use latest focus</button>${conflict?'<button type="button" class="button" data-action="rebase-steering">Keep my edits</button>':''}`:''}</div></form>`:'<p class="small muted">This exploration has ended. Any unapplied requests are retained in its history.</p>'}${draft.message?`<p class="small" role="status">${esc(draft.message)}</p>`:''}${snapshot.messages.length?`<details data-disclosure="steering-history"><summary>Focus history · ${snapshot.messages.length} changes</summary><ol class="steering-history">${snapshot.messages.map(item=>`<li><div class="row"><strong>Revision ${number(item.revision)}</strong><span class="pill">${esc(labels[item.status])}</span></div><p>${esc(item.focus||'Restore normal exploration')}</p><p class="small muted">${date(item.created_at)} · ${item.agent_id?'Agent '+esc(short(item.agent_id)):'Workspace user'}${item.status==='not_applied'?' · No further planning decision used this focus.':''}</p><span class="mono small">${esc(item.steering_id)}</span>${item.decision_id?`<p class="mono small">Planning decision ${esc(item.decision_id)}</p>`:''}</li>`).join('')}</ol></details>`:''}</div></section>`;
}
export async function submitSteering(id=state.runId){
  if(state.runId!==id||state.report?.run.run_id!==id)return;
  const draft=steeringDraft(id),snapshot=state.report.steering||{revision:0,messages:[]};
  if(draft.busy||!draft.dirty||!draft.command&&draft.revision!==snapshot.revision)return;
  draft.command??={steering_id:crypto.randomUUID(),expected_revision:draft.revision,focus:draft.focus.trim()};
  sessionStorage.setItem('scout.pending-focus.'+id,JSON.stringify(draft.command));
  draft.busy=true;draft.error='';render();
  const token=state.token,developmentAccess=state.developmentAccess,sameSession=()=>token===state.token&&developmentAccess===state.developmentAccess&&steeringDrafts.get(id)===draft;
  try{
    const saved=await (await api('/v1/runs/'+id+'/steering',draft.command)).json();if(!sameSession())return;
    if(state.report?.run.run_id===id)state.report.steering=mergeSteering(saved,state.report.steering);
    sessionStorage.removeItem('scout.pending-focus.'+id);draft.command=null;draft.dirty=false;
    draft.message='Focus request saved. Follow its acknowledgement in the history.';
  }catch(error){
    if(!sameSession())return;draft.error=error.message;
    if(['steering_revision_conflict','steering_id_conflict','invalid_steering_request','steering_requires_exploration','steering_limit_reached'].includes(error.code)){
      draft.command=null;sessionStorage.removeItem('scout.pending-focus.'+id);
      try{const saved=await get('/v1/runs/'+id+'/steering');if(sameSession()&&state.report?.run.run_id===id)state.report.steering=mergeSteering(saved,state.report.steering);}catch{}
    }
  }finally{draft.busy=false;if(sameSession()&&state.runId===id)render();}
}
