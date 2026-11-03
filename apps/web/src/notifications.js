// Pop-up notifications for the few changes worth interrupting for: new findings on a project, a test
// that finished or stopped, a fix check result and a sign-in request. They are worked out by comparing
// one refresh with the notifiedState one; the first refresh only records where things stand.
// Queued and started tests, progress and anything the person just did themselves are not notified.
import {esc} from '/assets/ui/format.js';
import {websiteHref,websiteLabel,websiteOrigin} from './websites.js';

const NOTIFICATIONS_KEY='scout.notifications';
const NOTIFY_ACTIVE=['queued','running'];
const NOTIFY_STOPPED={failed:'failed',interrupted:'was interrupted',blocked:'is blocked'};
let notifiedState=null;

export function notificationsEnabled(){try{return localStorage.getItem(NOTIFICATIONS_KEY)!=='off';}catch{return true;}}
export function setNotificationsEnabled(enabled){try{localStorage.setItem(NOTIFICATIONS_KEY,enabled?'on':'off');}catch{}if(!enabled)clearNotifications();}
export function resetNotifications(){notifiedState=null;clearNotifications();}

function notificationJobOrigin(job,jobs,runs){
  const parent=jobs.find(item=>item.job_id===job.parent_job_id),run=runs.find(item=>item.run_id===job.run_id);
  return websiteOrigin(job.request?.target_url||job.request?.candidate_url||parent?.request?.target_url||run?.target_url||'');
}
function notificationSnapshot({jobs=[],websites=[],requests=[]}){
  return {jobs:new Map(jobs.map(job=>[job.job_id,job.status])),pending:new Map(websites.map(site=>[site.origin,Number(site.pending_findings)||0])),requests:new Set(requests.filter(r=>r.status==='waiting').map(r=>r.access_id))};
}
// Pure: the notifications implied by going from `before` to the data in `next`.
export function notificationChanges(before,{jobs=[],websites=[],requests=[],runs=[]}){
  const events=[],found=new Map();
  for(const site of websites){
    const now=Number(site.pending_findings)||0,was=before.pending.get(site.origin);
    if(was!==undefined&&now>was)found.set(site.origin,now-was);
  }
  for(const job of jobs){
    const was=before.jobs.get(job.job_id);
    // Only work seen running in an earlier refresh can finish now. Automatic rechecks report through their parent.
    if(!NOTIFY_ACTIVE.includes(was)||NOTIFY_ACTIVE.includes(job.status)||job.parent_job_id)continue;
    const origin=notificationJobOrigin(job,jobs,runs),site=origin?websiteLabel(origin):'Your test',fix=job.request?.kind==='verify_fix';
    // Cancelling is the person's own action, so it is not news.
    if(job.status==='cancelled')continue;
    const runHref=job.run_id?'/workspace/'+job.run_id:origin?websiteHref(origin):'/workspace';
    if(job.status==='completed'){
      const count=found.get(origin)||0;found.delete(origin);
      if(fix)events.push({tone:'info',title:'Fix check finished',detail:site,href:job.request?.issue_id?'/issues/'+job.request.issue_id:runHref,label:'See the result'});
      else events.push({tone:count?'attention':'info',title:count?`${count} new ${count===1?'finding':'findings'}`:'Test finished',detail:count?`${site} · test finished`:`${site} · nothing new to review`,href:count&&job.run_id?runHref+'/findings':runHref,label:count?'Review':'Open'});
    }else if(NOTIFY_STOPPED[job.status])events.push({tone:'error',title:`${fix?'Fix check':'Test'} ${NOTIFY_STOPPED[job.status]}`,detail:job.error?`${site} · ${job.error}`:site,href:runHref,label:'Open',sticky:true});
  }
  // Findings that arrive while a test is still running, or from an agent's test.
  for(const [origin,count] of found)events.push({tone:'attention',title:`${count} new ${count===1?'finding':'findings'}`,detail:websiteLabel(origin),href:websiteHref(origin),label:'Open project'});
  for(const request of requests)if(request.status==='waiting'&&!before.requests.has(request.access_id))
    events.push({tone:'attention',title:'Sign-in requested',detail:`${websiteLabel(request.origin)} · the test is waiting for you`,action:'open-activity',label:'Open Activity',sticky:true});
  return events;
}
// Called after every successful refresh.
export function observeWorkspace(data){
  const next=notificationSnapshot(data);
  const events=notifiedState?notificationChanges(notifiedState,data):[];
  notifiedState=next;
  if(notificationsEnabled())for(const event of events)showNotification(event);
  return events;
}

function notificationContainer(){return globalThis.document?.getElementById?.('notifications')||null;}
export function clearNotifications(){const node=notificationContainer();if(node)node.replaceChildren?.();}
export function showNotification(event){
  const node=notificationContainer();if(!node?.append)return;
  const doc=globalThis.document,card=doc.createElement('article');card.className='notification '+(event.tone||'info');
  card.innerHTML=`<div class="notification-body"><strong>${esc(event.title)}</strong>${event.detail?`<p>${esc(event.detail)}</p>`:''}</div><div class="notification-actions">${event.href?`<a class="button" href="${esc(event.href)}">${esc(event.label||'Open')}</a>`:event.action?`<button type="button" class="button" data-notification-action="${esc(event.action)}">${esc(event.label||'Open')}</button>`:''}<button type="button" class="notification-close" aria-label="Dismiss notification">×</button></div>`;
  const remove=()=>card.remove();
  card.querySelector('.notification-close')?.addEventListener('click',remove);
  card.querySelector('a,[data-notification-action]')?.addEventListener('click',()=>setTimeout(remove,0));
  node.append(card);
  // At most three at once; the oldest goes first.
  while(node.children.length>3)node.firstElementChild?.remove();
  if(!event.sticky)setTimeout(remove,10000);
}
