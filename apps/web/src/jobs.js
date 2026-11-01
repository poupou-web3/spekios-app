// Browser job admission, cancellation and following a launched job to its run.
import {button,toast} from '/assets/ui/components.js';
import {esc} from '/assets/ui/format.js';
import {api} from './api.js';
import {refresh,render} from './app.js';
import {state} from './state.js';
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
