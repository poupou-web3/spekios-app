// Browser job queue: admission, worker execution, lineage and stop controls.
import {button,empty,icon,pill,toast} from '/assets/ui/components.js';
import {date,elapsed,esc,opsMode,short} from '/assets/ui/format.js';
import {api} from '../api.js';
import {refresh,render} from '../app.js';
import {state} from '../state.js';
export function jobsView(compact=false){
  const recent=state.jobs.slice(0,50),search=String(state.jobSearch||'').toLowerCase(),filter=state.jobFilter||'all',mode=state.jobMode||'all';
  const statusMatches=job=>filter==='all'||filter==='attention'&&['failed','interrupted','blocked'].includes(job.status)||job.status===filter;
  const jobs=compact?recent.slice(0,5):recent.filter(job=>statusMatches(job)&&(mode==='all'||job.execution_mode===mode)&&[job.job_id,job.run_id,job.parent_job_id,job.status,job.execution_mode,job.request?.kind,job.request?.target_url,job.request?.source_action_id,job.error,job.settings?.provider,job.settings?.model].join(' ').toLowerCase().includes(search));
  const controls=compact?'':`<div class="queue-toolbar"><label class="search">${icon('search')}<span class="sr-only">Search browser jobs</span><input id="job-search" placeholder="Search URL, job ID or error…" value="${esc(state.jobSearch||'')}"></label><label class="small muted">Status <select id="job-filter" data-action="job-filter">${[['all','All statuses'],['queued','Queued'],['running','Running'],['attention','Needs attention'],['completed','Completed'],['cancelled','Cancelled'],['failed','Failed'],['interrupted','Interrupted'],['blocked','Needs access']].map(([value,label])=>`<option value="${value}" ${filter===value?'selected':''}>${label}</option>`).join('')}</select></label><label class="small muted">Mode <select id="job-mode" data-action="job-mode">${[['all','All modes'],['live','Live'],['protocol_fixture','Simulated']].map(([value,label])=>`<option value="${value}" ${mode===value?'selected':''}>${label}</option>`).join('')}</select></label></div><p class="small muted section-copy">Showing ${jobs.length} of the latest ${recent.length} jobs returned by the server (maximum 50). Filters do not search older history.</p>`;
  return `<section class="panel"><div class="panel-header"><div><h2>${compact?'Recent browser jobs':'Browser job queue'}</h2><p class="small muted">${compact?'Latest five of the latest 50 returned records':'Queue admission, worker execution and retained results'}</p></div><span class="small muted">One worker · idempotent admission</span></div>${controls}${jobs.length?`<div class="table-wrap"><table><thead><tr><th>Job</th><th>Status / worker</th><th>Mode</th><th>Created / elapsed</th><th>Result</th></tr></thead><tbody>${jobs.map(job=>{const request=job.request||{},target=request.target_url||request.source_action_id;return `<tr><td><div class="table-title">${request.kind==='verify_fix'?'Verify candidate fix':request.kind==='explore'?'Explore application':job.parent_job_id?'Automatic reproduction':'Reproduce finding'}</div><div class="table-sub" title="${esc(target||job.job_id)}">${esc(request.target_url||short(request.source_action_id))}</div><span class="mono muted">${esc(short(job.job_id))}</span>${parentJobLink(job)}${job.error?`<div class="table-sub" title="${esc(job.error)}">${esc(job.error)}</div>`:''}</td><td>${pill(job.cancel_requested_at&&job.status==='running'?'cancelling':job.status)}<div class="table-sub mono">${job.worker_id?esc(short(job.worker_id)):'No worker assigned'}</div></td><td class="muted">${opsMode(job.execution_mode)}</td><td class="muted">${esc(date(job.created_at))}<div class="table-sub">${job.started_at?`${esc(elapsed(job.started_at,job.finished_at))} since start`:job.status==='queued'?'Not started':'Not launched'}</div></td><td><div class="table-actions">${job.run_id?`<a class="button" href="#/models/${esc(job.run_id)}">Inspect run ${icon('arrow')}</a>`:job.error?button('job-error','Details','info',`data-id="${esc(job.job_id)}"`):`<span class="muted">${job.status==='cancelled'?'Cancelled before launch':job.status==='queued'?'Awaiting worker':job.status==='running'?'Starting browser':'No run recorded'}</span>`}${cancelButton('job',job)}</div></td></tr>`;}).join('')}</tbody></table></div>`:empty(recent.length?'No matching browser jobs':'No queued browser jobs',recent.length?'Adjust the status, mode or search filters. Only the latest 50 returned jobs are searchable.':'Start an exploration in the workspace to see admission, execution and results here. CLI runs remain available in the run picker.')}</section>`;
}
export function parentJobLink(job){
  if(!job.parent_job_id)return '';
  const parent=state.jobs.find(j=>j.job_id===job.parent_job_id);
  return parent?.run_id?`<div><a class="button quiet" href="#/models/${esc(parent.run_id)}">Parent exploration ${esc(short(job.parent_job_id))} ${icon('arrow')}</a></div>`:`<div>${button('job-lineage','Parent job '+short(job.parent_job_id),'flow',`data-id="${esc(job.job_id)}"`)}</div>`;
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
