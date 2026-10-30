// Automatic fresh-browser rechecks of suspected bugs, and manual replay controls.
import {button,icon,pill,toast} from '/assets/ui/components.js';
import {esc,number,short} from '/assets/ui/format.js';
import {api} from '../api.js';
import {refresh,render} from '../app.js';
import {state} from '../state.js';
import {canStart} from './home.js';
export function automaticReason(reason){
  return {awaiting_queue:'Waiting for the browser queue',scheduled:'Fresh-browser check scheduled',case_limit:'Automatic check limit reached',action_limit:'Additional action budget exhausted',reviewed:'A human has already reviewed this finding',existing_attempt:'A reproduction already exists or is scheduled',source_unavailable:'The source exploration is no longer eligible',scope_unavailable:'The application is outside the current allowed origins',ineligible_assessment:'The assessment is not eligible for automatic reproduction',invalid_path:'The original path cannot be replayed',incomplete_path:'The original path has incomplete checks or evidence',session_unavailable:'The original saved sign-in session is unavailable',queue_capacity:'Waiting for room in the browser queue',queue_full:'Waiting for room in the browser queue',provider_unavailable:'Waiting for the configured model provider',gateway_unavailable:'Waiting for the model gateway',worker_unavailable:'Waiting for a browser worker',case_budget_exhausted:'Automatic check limit reached',action_budget_exhausted:'Additional action budget exhausted',replay_budget_exceeded:'This replay exceeds the remaining action budget',already_reproduced:'A reproduction already exists',reproduction_already_queued:'A reproduction is already queued',user_cancelled:'Automatic checks were stopped by the user',cancelled:'Automatic checks were stopped',source_cancelled:'The source exploration was cancelled',expectation_uncertain:'The expected result needs clarification',incomplete_evidence:'Complete source evidence is required',source_not_reviewable:'The source action is not eligible for reproduction',awaiting_source_completion:'Waiting for the source exploration to finish',ready:'Ready for a fresh-browser check'}[reason]||String(reason||'').replaceAll('_',' ');
}
export function automaticTasks(){return state.report?.automatic_reproductions||[];}
export function automaticTaskActive(task){
  if(task.status==='pending')return true;
  if(task.status!=='queued')return false;
  if(task.child_job)return ['queued','running'].includes(task.child_job.status);
  return !task.reproduction?.finished_at&&!['completed','failed','interrupted','blocked','cancelled'].includes(task.reproduction?.status);
}
export function automaticTaskPill(task){
  if(task.status==='skipped')return '<span class="pill">Skipped</span>';
  if(task.status==='pending')return '<span class="pill amber">Waiting to queue</span>';
  const job=task.child_job;
  return pill(job?.cancel_id&&job.status==='running'?'cancelling':job?.status||task.reproduction?.status||'queued');
}
export function automaticSourceLink(task,label='View source action'){
  return `<a class="button quiet" href="#/workspace/${esc(task.source_run_id)}/${esc(task.source_action_id)}" ${task.source_run_id===state.report?.run.run_id?`data-action="select-action" data-source-action="true" data-id="${esc(task.source_action_id)}"`:''}>${esc(label)} ${icon('arrow')}</a>`;
}
export function automaticTaskView(task){
  const job=task.child_job,reproduction=task.reproduction,replayId=job?.run_id||reproduction?.replay_run_id;
  return `<article class="automatic-check"><div class="row">${automaticTaskPill(task)}<strong>Check source action ${esc(short(task.source_action_id))}</strong><span class="small muted">${number(task.planned_actions)} planned browser actions</span></div>${task.reason?`<p class="small muted">${esc(automaticReason(task.reason))}</p>`:''}${job?.error?`<p class="small review-error">${esc(job.error)}</p>`:''}<div class="row">${automaticSourceLink(task)}${replayId?`<a class="button" href="#/workspace/${esc(replayId)}">View reproduction ${icon('arrow')}</a>`:job?`<span class="small muted">Job ${esc(short(job.job_id))} · ${job.status==='cancelled'?'Cancelled before launch':'Awaiting worker'}</span>`:''}</div>${reproduction?.result?`<div class="automatic-result">${pill(reproduction.result.outcome)}<p class="small">${esc(reproduction.result.reason||'Recorded reproduction outcome')}</p></div>`:''}</article>`;
}
export function automaticPanel(){
  const run=state.report?.run;if(!run)return '';
  const tasks=automaticTasks(),replay=run.config?.replay_of;
  if(replay){
    const task=tasks.find(t=>t.child_job?.run_id===run.run_id||t.reproduction?.replay_run_id===run.run_id);
    if(!task)return '';
    return `<section class="notice automatic-lineage">${icon('refresh')}<div><strong>Automatic fresh-browser check</strong><p class="small">This run rechecks a suspected bug from exploration ${esc(short(task.source_run_id))}. The outcome awaits human review.</p>${automaticSourceLink(task)}<a class="button quiet" href="#/workspace/${esc(task.source_run_id)}">View parent exploration ${icon('arrow')}</a></div></section>`;
  }
  const policy=run.config?.automatic_reproduction_policy;
  if(!policy?.enabled&&!tasks.length)return '';
  const stopping=!!run.auto_reproduction_cancel_id||state.cancelling.has('automatic:'+run.run_id),planning=policy?.enabled&&!run.auto_reproduction_planned_at&&!run.auto_reproduction_cancelled_at&&['active','completed'].includes(run.lifecycle);
  const active=planning||tasks.some(automaticTaskActive),retryNeeded=!!run.auto_reproduction_cancel_id&&tasks.some(t=>automaticTaskActive(t)&&t.child_job&&!t.child_job.cancel_id&&!t.child_job.cancel_requested_at);
  return `<section class="panel automatic-panel"><div class="panel-header"><div><h2>Automatic checks</h2><p class="small muted">Up to ${number(policy?.max_cases)} suspected bugs · ${number(policy?.max_actions)} additional browser actions in total</p></div>${active?button('cancel-automatic',stopping?'Stopping automatic checks…':'Stop automatic checks','close',`data-id="${esc(run.run_id)}" ${stopping?'disabled':''}`):''}</div><div class="automatic-body"><p class="small muted">Fresh-browser outcomes preserve the original evidence. Human review is required to confirm a product defect.</p>${stopping||run.auto_reproduction_cancelled_at?`<p class="small" role="status">${active?'Stopping automatic checks.':'Automatic checks stopped.'} Recorded actions are retained; model calls already sent may still finish.</p>`:planning?'<p class="small" role="status">Waiting for exploration to finish and checks to be planned.</p>':''}${retryNeeded?`<div class="automatic-retry"><p class="small muted">A child stop request is still unacknowledged. Retrying uses the same cancellation.</p>${button('retry-automatic','Retry stop requests','refresh',`data-id="${esc(run.run_id)}" ${state.cancelling.has('automatic:'+run.run_id)?'disabled':''}`)}</div>`:''}${tasks.length?tasks.slice(0,12).map(automaticTaskView).join('')+(tasks.length>12?'<p class="small muted">Additional task records are available in the exported report.</p>':''):!planning&&!stopping?'<p class="small muted">No automatic replays were selected for this exploration.</p>':''}</div></section>`;
}
export function replayControl(action,reproduction,eligible){
  const task=automaticTasks().find(t=>t.source_action_id===action.action_id&&automaticTaskActive(t));
  if(task)return `<div class="automatic-action-status">${automaticTaskPill(task)}<span class="small">Automatic fresh-browser check ${task.status==='pending'?'is waiting to queue':'is already scheduled'}.</span>${task.reason?`<span class="small muted">${esc(automaticReason(task.reason))}</span>`:''}${task.child_job?.run_id?`<a class="button" href="#/workspace/${esc(task.child_job.run_id)}">View reproduction ${icon('arrow')}</a>`:''}</div>`;
  if(reproduction)return `<a class="button" href="#/workspace/${esc(reproduction.replay_run_id)}">${icon('refresh')}View reproduction</a>`;
  if(eligible)return `<button class="button accent" data-action="reproduce" data-id="${esc(action.action_id)}" ${!canStart()||state.submitting?'disabled':''}>${icon('refresh')}Replay in fresh browser</button>`;
  return button('action-json','Inspect action','code');
}
export async function cancelAutomatic(id){
  const key='automatic:'+id;if(state.cancelling.has(key))return;
  const token=state.token,developmentAccess=state.developmentAccess;state.cancelling.add(key);render();
  try{
    const result=await (await api('/v1/runs/'+id+'/automatic-reproductions/cancel',{})).json();
    if((token!==state.token||developmentAccess!==state.developmentAccess))return;
    if(state.report?.run.run_id===id){state.report.run.auto_reproduction_cancel_id=result.cancellation_id;if(result.status==='cancelled')state.report.run.auto_reproduction_cancelled_at=new Date().toISOString();}
    toast(result.status==='cancelled'?'Automatic checks stopped. Recorded evidence is retained.':'Stopping automatic checks. In-flight model usage may still settle.');await refresh();
  }catch(error){if((token===state.token&&developmentAccess===state.developmentAccess))toast(error.message);}
  finally{state.cancelling.delete(key);if((token===state.token&&developmentAccess===state.developmentAccess))render();}
}
