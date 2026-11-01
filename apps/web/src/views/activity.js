// Workspace-wide activity lives outside website pages and recorded sessions.
import {button,empty,icon,pill} from '/assets/ui/components.js';
import {date,esc,number,short} from '/assets/ui/format.js';
import {cancelButton,restartButton} from '../jobs.js';
import {state} from '../state.js';
import {websiteFavicon,websiteLabel,websiteOrigin} from '../websites.js';

function activeActivityJobs(){return state.jobs.filter(job=>['queued','running'].includes(job.status));}
function activityAccessRequests(){return (state.access.requests||[]).filter(request=>['waiting','active'].includes(request.status));}
function trackedActivityFailure(){return state.jobs.find(job=>job.job_id===state.trackedJobId&&!job.run_id&&!['queued','running'].includes(job.status));}
export function activityButton(mobile=false){
  const running=activeActivityJobs().length,notifications=activityAccessRequests().length+(state.error?1:0)+(trackedActivityFailure()?1:0),total=running+notifications;
  return `<button id="activity-trigger${mobile?'-mobile':''}" class="nav-item activity-trigger" data-action="open-activity" aria-haspopup="dialog" aria-expanded="${!!state.drawer?.activity}"${state.drawer?.activity?' aria-controls="workspace-activity"':''} aria-label="Activity, ${running} running, ${notifications} notifications">${icon('pulse')}<span>Activity</span>${total?`<span class="activity-count ${notifications?'attention':''}" aria-hidden="true">${number(total)}</span>`:''}</button>`;
}
function activityJobTarget(job){
  const parent=state.jobs.find(item=>item.job_id===job.parent_job_id),run=state.runs.find(item=>item.run_id===job.run_id);
  return job.request?.target_url||job.request?.candidate_url||parent?.request?.target_url||run?.target_url||(state.report?.run?.run_id===job.run_id?state.report.run.target_url:'');
}
function activityJobCard(job){
  const target=activityJobTarget(job),origin=websiteOrigin(target),active=['queued','running'].includes(job.status),tracked=job.job_id===state.trackedJobId;
  const label=job.request?.kind==='explore'?'Website exploration':job.request?.kind==='verify_fix'?'Fix verification':job.parent_job_id?'Automatic reproduction':job.request?.kind==='reproduce'?'Fresh-browser reproduction':'Test';
  const status=job.cancel_requested_at&&active?'cancelling':job.status;
  return `<article class="activity-card"><div class="activity-card-heading">${websiteFavicon(origin)}<div><strong>${esc(origin?websiteLabel(origin):label)}</strong><p class="small muted">${esc(label)} · ${job.created_at?esc(date(job.created_at)):'Job '+esc(short(job.job_id))}</p></div>${pill(status)}</div>${target?`<p class="activity-target small mono">${esc(target)}</p>`:''}${tracked&&!job.run_id?`<p class="small ${active?'muted':'error'}">${active?'Your test will open here when the browser starts.':job.status==='cancelled'?'Your test was cancelled before launch.':'Your test could not start.'}</p>`:''}${job.error?`<p class="activity-error small">${esc(job.error)}</p>`:''}<div class="activity-actions">${job.run_id?`<a class="button" data-action="activity-view-run" data-id="${esc(job.run_id)}" href="#/workspace/${esc(job.run_id)}">View run ${icon('arrow')}</a>`:''}${active?cancelButton('job',job):restartButton('job',job)}${tracked&&!active&&!job.run_id?button('dismiss-tracked-job','Dismiss','close'):''}</div></article>`;
}
export function accessNotifications(){
  return activityAccessRequests().map(request=>`<article class="activity-card access-notice"><div class="activity-card-heading">${icon('globe')}<strong>${request.status==='active'?'Private sign-in in progress':request.reason==='login_available'?'Sign-in is available':'Sign-in needed to continue'}</strong></div><p class="activity-target small mono">${esc(request.origin)}</p><p class="small muted">${request.status==='active'?'The browser is reserved for the person signing in.':'Sign in yourself in the test browser, or skip sign-in to explore public pages for the rest of this run.'}</p><span class="small muted">Request ${esc(short(request.access_id))} · expires ${esc(date(request.expires_at))}</span><div class="activity-actions">${request.status==='waiting'?button('app-login','Open private login','globe',`data-id="${esc(request.access_id)}"`):''}${request.status==='waiting'?button('create-account','Try creating an account','arrow',`data-id="${esc(request.access_id)}"`)+button('skip-login','Skip sign-in for this run','arrow',`data-id="${esc(request.access_id)}"`):''}${button('cancel-login','Cancel run','close',`data-id="${esc(request.access_id)}"`)}</div></article>`).join('');
}
export function activityView(){
  const active=activeActivityJobs(),recent=state.jobs.filter(job=>!['queued','running'].includes(job.status)).sort((a,b)=>String(b.finished_at||b.created_at||'').localeCompare(String(a.finished_at||a.created_at||''))).slice(0,10),failure=trackedActivityFailure();
  // Keep a failed admission visible even when newer results fill the recent list.
  if(failure&&!recent.includes(failure))recent.unshift(failure);
  const notifications=accessNotifications()+(state.error?`<article class="activity-card activity-error" role="alert"><strong>Workspace update</strong><p>${esc(state.error)}. Showing the last available data.</p>${button('refresh','Try again','refresh')}</article>`:'');
  return `<p class="activity-intro small muted">Across all websites. Keep testing while you review another session.</p>${notifications?`<section class="activity-section" aria-labelledby="activity-notifications"><h3 id="activity-notifications">Notifications</h3>${notifications}</section>`:''}<section class="activity-section" aria-labelledby="activity-running"><h3 id="activity-running">In progress <span class="small muted">${number(active.length)}</span></h3>${active.map(activityJobCard).join('')||'<p class="activity-idle small muted">No tests running.</p>'}</section><section class="activity-section" aria-labelledby="activity-recent"><h3 id="activity-recent">Recent results</h3>${recent.map(activityJobCard).join('')||empty('All quiet here','Results and test updates appear here.','check')}</section>`;
}
