// Browser job admission, cancellation, restarts and following a launched job to its run.
import {button,icon,toast} from '/assets/ui/components.js';
import {esc,name} from '/assets/ui/format.js';
import {api} from './api.js';
import {refresh,render} from './app.js';
import {state} from './state.js';
import {canStart} from './views/home.js';
// Runs that ended before finishing. Each can start again as a new job.
export const STOPPED=['failed','interrupted','blocked','cancelled'];
// The request that launched a stopped run or a job that never started, ready to submit again.
// The new job takes the current settings; the earlier run and its evidence stay as they are.
// Fix verifications start again from their issue page.
export function restartRequest(kind,item){
  if(kind==='run'&&(!STOPPED.includes(item.lifecycle)||item.config?.runtime_version!=='explorer-v1'||item.config.fix_verification))return null;
  const job=kind==='job'?item:state.jobs.find(j=>j.run_id===item.run_id||j.previous_run_ids?.includes(item.run_id));
  // A job resumed after an interruption carries on in a later run.
  if(kind==='run'&&job?.run_id&&job.run_id!==item.run_id)return null;
  // Only the latest fifty jobs are loaded. An older run records enough to start it again.
  const source=job?.request??(kind==='job'?null:item.config.replay_of?{kind:'reproduce',source_action_id:item.config.replay_of.source_action_id}:{kind:'explore',target_url:item.target_url,auth_mode:item.config.auth_mode,auto_reproduce:item.config.automatic_reproduction_policy?.enabled});
  let request;
  if(source?.kind==='reproduce')request={kind:'reproduce',source_action_id:source.source_action_id};
  else if(source?.kind==='explore'){
    const {target_url,auth_mode,session_id,auto_reproduce,app_memory}=source;
    // An expired or removed saved sign-in would refuse the job. Without it, the new run asks for sign-in.
    const session=(state.access.sessions||[]).some(s=>s.session_id===session_id&&!s.revoked_at&&new Date(s.expires_at)>new Date());
    request={kind:'explore',target_url,viewport_profile:job?.settings?.viewportProfile??source.viewport_profile??item.config?.viewport_profile,auth_mode,auto_reproduce,app_memory,...(session?{session_id}:{}),...(job?.project_id?{project_id:job.project_id}:{})};
  }else return null;
  // The same test is already queued or running, for example a job requeued after an interruption.
  const queued=state.jobs.some(j=>['queued','running'].includes(j.status)&&(request.kind==='reproduce'?j.request?.source_action_id===request.source_action_id:j.request?.kind==='explore'&&j.request.target_url===request.target_url&&(j.settings?.viewportProfile??j.request.viewport_profile)===request.viewport_profile));
  return queued?null:request;
}
export function restartButton(kind,item,compact=false){
  if(!restartRequest(kind,item))return '';
  const id=kind==='run'?item.run_id:item.job_id,label=kind==='job'?'Try again':'Run again',disabled=!canStart()||state.submitting?'disabled':'';
  return compact?`<button class="button icon" data-action="restart-${kind}" data-id="${esc(id)}" aria-label="Run ${esc(name(item))} again" title="${label}" ${disabled}>${icon('refresh')}</button>`
    :`<button class="button primary" data-action="restart-${kind}" data-id="${esc(id)}" ${disabled}>${icon('refresh')}${label}</button>`;
}
export async function restartWork(kind,id){
  const item=kind==='job'?state.jobs.find(j=>j.job_id===id):state.report?.run?.run_id===id?state.report.run:state.runs.find(r=>r.run_id===id);
  const request=item&&restartRequest(kind,item);
  if(request)await submitJob(request);
}
export function cancelButton(kind,item){
  const active=kind==='run'?item.lifecycle==='active'&&item.config?.runtime_version==='explorer-v1':['queued','running'].includes(item.status);
  if(!active)return '';
  const id=kind==='run'?item.run_id:item.job_id;
  const stopping=!!item.cancel_requested_at||state.cancelling.has(id);
  return button('cancel-'+kind,stopping?'Stopping…':kind==='job'&&item.status==='queued'?'Cancel queued job':'Stop run','close',`data-id="${esc(id)}" ${stopping?'disabled':''}`);
}
export async function cancelWork(kind,id){
  if(state.cancelling.has(id))return;
  state.cancelling.add(id);render();
  try{
    const result=await (await api((kind==='run'?'/v1/runs/':'/v1/browser-jobs/')+id+'/cancel',{})).json();
    toast(result.status==='already_finished'?'This work has already finished.':result.status==='cancelled'?'Cancelled. Recorded evidence is retained.':'Stopping. In-flight model usage may still settle.');
    await refresh();
  }catch(error){toast(error.message);}
  finally{state.cancelling.delete(id);render();}
}
export function followSubmittedJob(){
  if(state.view!=='workspace'||state.runId||!state.trackedJobId)return false;
  const job=state.jobs.find(j=>j.job_id===state.trackedJobId);
  if(!job?.run_id)return false;
  clearTrackedJob();
  location.hash='#/workspace/'+job.run_id;return true;
}
export function clearTrackedJob(){state.trackedJobId=null;sessionStorage.removeItem('scout.tracked-job');}
export async function submitJob(request){
  if(state.submitting)return;state.submitting=true;state.error='';state.launchError='';render();
  const token=state.token,developmentAccess=state.developmentAccess,browserAuth=state.browserAuth,originView=state.view,originRun=state.runId;
  let saved;try{saved=JSON.parse(sessionStorage.getItem('scout.pending-job')||'null');}catch{}
  const spec=saved&&JSON.stringify(saved.request)===JSON.stringify(request)?saved:{request,job_id:crypto.randomUUID()};
  sessionStorage.setItem('scout.pending-job',JSON.stringify(spec));
  try{
    const response=await (await api('/v1/browser-jobs',{job_id:spec.job_id,...request})).json();if((token!==state.token||developmentAccess!==state.developmentAccess||browserAuth!==state.browserAuth))return;
    sessionStorage.removeItem('scout.pending-job');toast(response.reused?'Showing the existing job.':'Queued. Your test will open here when the browser starts.');
    if(state.view===originView&&state.runId===originRun){
      if(originView==='workspace'){
        state.trackedJobId=response.job.job_id;sessionStorage.setItem('scout.tracked-job',state.trackedJobId);
        state.runId=null;state.report=null;state.actionId=null;location.hash='#/workspace';
      }
    }
    await refresh();
  }catch(error){if((token===state.token&&developmentAccess===state.developmentAccess&&browserAuth===state.browserAuth)){if(error.code==='target_origin_not_allowed'&&request.kind==='explore')state.launchError='Public https sites can be tested from here. Other addresses have to be added to this server’s allowed origins.';else state.error=error.message;}}
  finally{state.submitting=false;if((token===state.token&&developmentAccess===state.developmentAccess&&browserAuth===state.browserAuth))render();}
}
