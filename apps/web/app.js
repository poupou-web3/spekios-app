import {workspaceRequest,requireOk} from '/assets/workspace-http.js';
const root = document.querySelector('#app');
const state = { token: sessionStorage.getItem('scout.workspace-token') || '', connected:false, runs:[], jobs:[], workers:[], settings:{}, providers:{providers:[]}, operations:{}, usage:{}, report:null, runId:null, actionId:null, view:'workspace', tab:'actions', opsTab:'overview', image:'after', search:'', eventSearch:'', drawer:null, submitting:false, cancelling:new Set(), error:'', url:'', viewportProfile:null, expanded:new Set(), access:{requests:[],sessions:[]}, authMode:'auto', sessionId:'' };
Object.assign(state,{runFilter:'all',runMode:'all',jobSearch:'',jobFilter:'all',jobMode:'all',modelSearch:'',modelProvider:'all',modelStatus:'all',modelPurpose:'all',lastUpdatedAt:null,trackedJobId:null,developmentAccess:false,settingsRevision:0,configurationDraft:null});
const storedTrackedJob=sessionStorage.getItem('scout.tracked-job');
if(/^[\da-f-]{36}$/.test(storedTrackedJob||''))state.trackedJobId=storedTrackedJob;
const imageCache = new Map(), imagePending = new Set(), reviewDrafts = new Map();
const steeringDrafts = new Map();
const savedAutomaticChoice=sessionStorage.getItem('scout.auto-reproduce');
state.autoReproduce=savedAutomaticChoice==='true'?true:savedAutomaticChoice==='false'?false:null;
let imageEpoch = 0, refreshing = false, toastTimer, composing = false, renderIdentity = '', drawerOpener = null, reportToolsPromise;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const text = value => typeof value === 'object' ? JSON.stringify(value) : String(value ?? 'Not recorded');
const number = value => value == null ? '—' : Number(value).toLocaleString();
function tokenTotal(usage){
  const values=[usage.known_input_tokens,usage.known_output_tokens];
  if(values.every(value=>value==null))return 'Unknown';
  const incomplete=values.some(value=>value==null)||Number(usage.incomplete_usage_attempts)>0||usage.complete===false;
  return (incomplete?'≥ ':'')+number(values.reduce((sum,value)=>sum+Number(value??0),0));
}
function costTotal(usage){
  if(usage.provider_reported_cost_usd==null)return 'Unknown';
  return (Number(usage.unpriced_attempts)>0?'≥ ':'')+'$'+Number(usage.provider_reported_cost_usd).toFixed(4);
}
const short = id => id ? id.slice(0,8) : '—';
const date = value => value ? new Date(value).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '—';
const elapsed = (start,end) => { if(!start)return '—'; const s=Math.max(0,Math.round(((end?new Date(end):new Date())-new Date(start))/1000)); return s<60?`${s}s`:`${Math.floor(s/60)}m ${s%60}s`; };
const name = run => { try {const u=new URL(run.target_url); return u.hostname+(u.pathname==='/'?'':u.pathname);}catch{return run.target_url||'Untitled run';} };
const fixture = run => run.config?.training_status==='excluded_fixture';
const icon = key => `<svg aria-hidden="true" viewBox="0 0 24 24">${{
  scout:'<circle cx="12" cy="12" r="7"/><path d="M12 2v5m0 10v5M2 12h5m10 0h5"/><circle cx="12" cy="12" r="1"/>',
  grid:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  pulse:'<path d="M2 12h5l3-8 4 16 3-8h5"/>',search:'<circle cx="10" cy="10" r="6.5"/><path d="m15 15 5 5"/>',
  arrow:'<path d="M4 12h16m-6-6 6 6-6 6"/>',chevron:'<path d="m9 5 7 7-7 7"/>',
  globe:'<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18"/>',
  play:'<path d="m8 4 12 8-12 8Z"/>',bug:'<path d="M9 7V5l-2-2m8 4V5l2-2M4 10h3m10 0h3M4 17l3-2m10 0 3 2M12 8v12"/><rect x="7" y="7" width="10" height="13" rx="5"/>',
  image:'<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 6-6 4 4 3-3 5 5"/>',
  flow:'<rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="15" width="6" height="6" rx="1"/><path d="M6 9v9h9m3-9V6H9"/>',
  check:'<path d="m5 12 4 4L19 6"/>',clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v6l4 2"/>',
  bolt:'<path d="m13 2-9 12h7l-1 8 10-12h-7Z"/>',refresh:'<path d="M20 9a8 8 0 1 0 0 6M20 3v6h-6"/>',
  download:'<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',copy:'<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  close:'<path d="m6 6 12 12M6 18 18 6"/>',logout:'<path d="M10 3H4v18h6m-1-9h12m-4-4 4 4-4 4"/>',
  code:'<path d="m8 5-7 7 7 7m8-14 7 7-7 7m-3-14-2 14"/>',database:'<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/>',
  info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v1"/>',layers:'<path d="m12 3 10 6-10 6L2 9Zm-9 11 9 5 9-5M3 18l9 5 9-5"/>',
}[key]||''}</svg>`;
function pill(value) {
  const map={cancelling:['Stopping…','amber'],completed:['Completed','green'],active:['Running','blue'],running:['Running','blue'],queued:['Queued',''],failed:['Failed','red'],interrupted:['Interrupted','amber'],blocked:['Needs access','amber'],cancelled:['Cancelled',''],waiting:['Needs sign-in','amber'],no_issue_observed:['No issue observed','green'],suspect:['Needs review','amber'],inconclusive:['Inconclusive',''],reproduced:['Reproduced','amber'],not_reproduced:['Not reproduced','green'],prepared:['Preparing',''],dispatched:['Executing','blue'],skipped:['Replanned before acting','amber'],evidence_failed:['Evidence gap','red'],available:['Available','green'],online:['Online','green']};
  const [label,color]=map[value]||[value||'Not assessed',''];return `<span class="pill ${color}">${esc(label)}</span>`;
}
const stat = (label,value,note,key) => `<div class="stat"><div class="stat-label">${esc(label)}${icon(key)}</div><div class="stat-value">${esc(value)}</div><div class="stat-note">${esc(note)}</div></div>`;
const empty = (title,description,key='layers') => `<div class="empty">${icon(key)}<h3>${esc(title)}</h3><p>${esc(description)}</p></div>`;
const json = value => `<pre class="json">${esc(JSON.stringify(value,null,2))}</pre>`;
const button = (action,label,key='',extra='') => `<button class="button" data-action="${action}" ${extra}>${key?icon(key):''}${esc(label)}</button>`;
function toast(message){const node=document.querySelector('#toast');node.textContent=message;node.classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>node.classList.remove('visible'),4500);}
async function api(path,body,extraHeaders={},timeoutMs=18000,signal=null){
  const token=state.token,developmentAccess=state.developmentAccess;
  const response=await workspaceRequest(path,{token:developmentAccess?'':token,body,headers:extraHeaders,timeoutMs,signal});
  if((token!==state.token||developmentAccess!==state.developmentAccess))throw new Error('Workspace disconnected.');
  if(response.status===401){closeReportExport();state.connected=false;state.developmentAccess=false;state.token='';state.configurationDraft=null;steeringDrafts.clear();state.error='Workspace access is required.';sessionStorage.removeItem('scout.workspace-token');clearImages();login();throw new Error('Workspace access is required.');}
  return requireOk(response);
}
const get = async path => (await api(path)).json();
function clearImages(){imageEpoch++;for(const url of imageCache.values())URL.revokeObjectURL(url);imageCache.clear();imagePending.clear();}
async function loadImages(){
  for(const node of root.querySelectorAll('[data-image-path]')){
    const path=node.dataset.imagePath;
    if(imageCache.has(path)){node.replaceChildren(Object.assign(document.createElement('img'),{src:imageCache.get(path),alt:node.dataset.alt}));continue;}
    if(imagePending.has(path))continue;
    imagePending.add(path);const epoch=imageEpoch;
    try{const response=await api(path);const url=URL.createObjectURL(await response.blob());if(epoch!==imageEpoch){URL.revokeObjectURL(url);continue;}imageCache.set(path,url);for(const n of root.querySelectorAll('[data-image-path]'))if(n.dataset.imagePath===path)n.replaceChildren(Object.assign(document.createElement('img'),{src:url,alt:n.dataset.alt}));}
    catch(error){if(node.isConnected)node.textContent=`Image unavailable: ${error.message}`;}
    finally{imagePending.delete(path);}
  }
}
function imagePanel(path,alt,pending=false){return path?`<div class="image-wrap" data-image-path="${esc(path)}" data-alt="${esc(alt)}"><span class="loading">Loading recorded image…</span></div><div class="evidence-tools">${button('zoom-image','Inspect at full resolution','image',`data-path="${esc(path)}" data-alt="${esc(alt)}"`)}<span class="small muted">Inspect small changes without shrinking the screenshot.</span></div>`:empty(pending?'Evidence is being collected':'No image available',pending?'This step has not finished recording its screenshot yet.':'This observation has an explicit evidence gap.','image');}
function canStart(){return state.providers.gateway_ready===true&&state.workers.some(w=>w.available)&&state.providers.providers.some(p=>p.provider===state.settings.provider&&p.configured)&&!!state.settings.model;}
function providerName(id){return {openai:'OpenAI',anthropic:'Anthropic',openrouter:'OpenRouter'}[id]||id||'No provider';}
function login(){
  root.innerHTML=`<main class="login" id="main-content" tabindex="-1"><form id="login-form" class="login-card"><div class="brand"><span class="mark">${icon('scout')}</span>scout<small>QA WORKSPACE</small></div><h1>See what your agent sees.</h1><p>Explore user flows, review the evidence, and understand every step along the way.</p><label for="token">Local workspace token</label><input id="token" name="token" type="password" required minlength="32" autocomplete="off" placeholder="Enter your workspace token">${state.error?`<div class="login-error" role="alert">${esc(state.error)}</div>`:''}<button class="button primary" type="submit">Connect to workspace ${icon('arrow')}</button><div class="small">Use SCOUT_API_TOKEN from this project's .env file. The token stays in this browser tab; it is never added to the URL.</div></form></main>`;
}
function shell(content){
  content=(state.view==='operations'?accessBanner():'')+content;
  const current=state.report?.run;
  const backoffice=state.view==='operations',runLink=state.runId?'/'+state.runId:'';
  return `<div class="app ${backoffice?'backoffice-app':'workspace-app'}"><aside class="sidebar"><a class="brand" href="#/workspace" aria-label="Scout workspace"><span class="mark">${icon('scout')}</span>scout<small>LOCAL</small></a><nav class="surface-switch" aria-label="Interface"><a class="surface-link ${!backoffice?'active':''}" href="#/workspace" ${!backoffice?'aria-current="page"':''}>${icon('grid')}Workspace</a><a class="surface-link ${backoffice?'active':''}" href="#/operations${runLink}" ${backoffice?'aria-current="page"':''}>${icon('pulse')}Back office</a></nav><div class="workspace-label eyebrow">${backoffice?'Manage & inspect':'Your testing space'}</div><a class="nav-item" href="/connect">${icon('code')}Connect your agent</a><a class="nav-item" href="/issues">${icon('bug')}Issues & fixes</a><nav aria-label="Main navigation">${backoffice?['overview','jobs','models','events','connections'].map(tab=>`<a class="nav-item ${state.opsTab===tab?'active':''}" href="#/operations${runLink}" data-action="ops-tab" data-value="${tab}" ${state.opsTab===tab?'aria-current="page"':''}>${icon({overview:'grid',jobs:'layers',models:'bolt',events:'code',connections:'globe'}[tab])}${{overview:'Overview',jobs:'Browser jobs',models:'Model calls',events:'Event log',connections:'Connections'}[tab]}</a>`).join(''):`<a class="nav-item ${!state.runId?'active':''}" href="#/workspace">${icon('layers')}Explorations<span class="nav-count">${number(state.operations.runs)}</span></a><a class="nav-item" href="#/workspace" data-action="focus-launch">${icon('play')}New exploration</a>`}</nav><div class="recent"><div class="eyebrow">Recent explorations</div>${state.runs.slice(0,8).map(r=>`<a class="recent-item ${r.run_id===state.runId?'selected':''}" href="#/workspace/${esc(r.run_id)}" title="${esc(r.target_url)}"><i class="dot ${r.lifecycle==='active'?'blue':r.lifecycle==='completed'?'green':'amber'}"></i><span>${esc(name(r))}</span></a>`).join('')||'<p class="small muted">Your recorded runs will appear here.</p>'}</div><div class="side-bottom"><div class="environment"><i class="dot ${state.workers.some(w=>w.available)?'green':'amber'}"></i><div>Local workspace<div class="small muted">${state.workers.some(w=>w.available)?'Browser worker online':'Browser worker offline'}</div></div></div>${state.developmentAccess?'<p class="small muted dev-access-note">Local development · sign-in disabled</p>':`<button data-action="logout">${icon('logout')}Disconnect workspace</button>`}</div></aside><main class="main" id="main-content" tabindex="-1"><header class="topbar"><div class="breadcrumb">${icon(backoffice?'pulse':'grid')}<a href="#/${state.view}">${backoffice?'Back office':'Workspace'}</a>${current?`${icon('chevron')}<span>${esc(name(current))}</span>`:'<span>/</span><span>Local project</span>'}</div><div class="topbar-right"><span>${state.error?'Refresh interrupted':state.lastUpdatedAt?'Updated '+esc(date(state.lastUpdatedAt)):'Recorded evidence'}</span><button class="button icon" data-action="refresh" aria-label="Refresh ${backoffice?'back office':'workspace'}">${icon('refresh')}</button>${state.developmentAccess?'<span class="pill dev-access-badge">DEV</span>':`<button class="button icon mobile-logout" data-action="logout" aria-label="Disconnect workspace">${icon('logout')}</button>`}<div class="avatar" aria-label="Local developer">L</div></div></header><div class="content">${state.error?`<div class="notice error" role="alert">${icon('info')}<span>${esc(state.error)}. Showing the last available data.</span></div>`:''}${content}</div></main>${drawer()}</div>`;
}
function hero(){
  const provider=state.providers.providers.find(p=>p.provider===state.settings.provider);
  const hint=!provider?.configured?`Connect ${providerName(state.settings.provider)} in your local configuration to start. <a href="#/operations" data-action="connections">View connections</a>`:!state.workers.some(w=>w.available)?'Waiting for the browser worker. Your recorded runs are still available.':`${providerName(state.settings.provider)} · ${esc(state.settings.model)} · up to ${state.settings.maxActions} actions${state.providers.test_mode?' · simulated provider':''}`;
  return `<section class="hero"><div class="hero-top"><div><h2>Start with a URL.</h2><p>Scout explores likely user flows and checks the result of every action.</p></div><span class="hero-icon">${icon('scout')}</span></div><form id="run-form" class="url-form"><label class="input-wrap">${icon('globe')}<span class="sr-only">Application URL</span><input id="target-url" name="url" type="url" required maxlength="2048" placeholder="https://your-app.example" value="${esc(state.url)}"></label><label class="viewport-picker"><span class="sr-only">Responsive viewport</span><select id="viewport-profile" name="viewport_profile">${['desktop','tablet','mobile'].map(profile=>`<option value="${profile}" ${(state.viewportProfile||state.settings.viewportProfile||'desktop')===profile?'selected':''}>${profile[0].toUpperCase()+profile.slice(1)}</option>`).join('')}</select></label><button type="submit" class="button primary" ${!canStart()||state.submitting?'disabled':''}>${icon('play')}${state.submitting?'Starting…':'Start exploration'}</button></form>${automaticOptions()}${authOptions()}<div class="helper">${icon('info')}${hint}</div></section>`;
}
function automaticEnabled(){return state.autoReproduce ?? state.settings.autoReproduce===true;}
function automaticOptions(){
  const enabled=automaticEnabled(),cases=Math.max(1,Math.min(3,Number(state.settings.maxAutoReproductions)||2)),actions=Math.max(1,Math.min(24,Number(state.settings.maxAutoReplayActions)||12));
  return `<div class="automatic-options"><label><input id="auto-reproduce" name="auto_reproduce" form="run-form" type="checkbox" ${enabled?'checked':''} aria-describedby="automatic-help"> Automatically recheck suspected bugs</label><p id="automatic-help" class="small muted">${enabled?`After exploration, use fresh browsers for up to ${cases} suspected bugs and ${actions} additional browser actions in total. Checks use additional model calls. Reproduced findings still need human review.`:'Optional fresh-browser checks use additional model calls. Findings remain subject to human review.'}</p></div>`;
}
function explorationRequest(form){
  state.url=String(form.get('url')||'').trim();const session=form.get('session_id');
  return {kind:'explore',target_url:state.url,viewport_profile:form.get('viewport_profile'),auth_mode:form.get('auth_mode')||'auto',auto_reproduce:automaticEnabled(),...(session?{session_id:session}:{})};
}
function runStatus(run){return run.lifecycle==='active'&&run.cancel_requested_at?'cancelling':run.lifecycle;}
function cancelButton(kind,item){
  const active=kind==='run'?item.lifecycle==='active'&&item.config?.runtime_version==='explorer-v1':['queued','running'].includes(item.status);
  if(!active)return '';
  const id=kind==='run'?item.run_id:item.job_id;
  const stopping=!!item.cancel_requested_at||state.cancelling.has(id);
  return button('cancel-'+kind,stopping?'Stopping…':kind==='job'&&item.status==='queued'?'Cancel queued job':'Stop run','close',`data-id="${esc(id)}" ${stopping?'disabled':''}`);
}
async function cancelWork(kind,id){
  if(state.cancelling.has(id))return;
  state.cancelling.add(id);render();
  try{
    const result=await (await api((kind==='run'?'/v1/runs/':'/v1/browser-jobs/')+id+'/cancel',{})).json();
    toast(result.status==='already_finished'?'This work has already finished.':result.status==='cancelled'?'Cancelled. Recorded evidence is retained.':'Stopping. In-flight model usage may still settle.');
    await refresh();
  }catch(error){toast(error.message);}
  finally{state.cancelling.delete(id);render();}
}
function jobBanner(){
  const active=state.jobs.filter(j=>['queued','running'].includes(j.status));
  const tracked=state.jobs.find(j=>j.job_id===state.trackedJobId),terminal=tracked&&!tracked.run_id&&!['queued','running'].includes(tracked.status);
  const stopped=terminal?`<div class="notice ${tracked.status==='cancelled'?'':'amber'}" role="status">${icon('info')}<div><strong>Your test ${tracked.status==='cancelled'?'was cancelled before launch':'could not start'}</strong><p>${esc(tracked.error||'No browser run was created. Recorded job details remain available in the back office.')}</p><span class="small mono">Job ${esc(tracked.job_id)}</span></div><a class="button" href="#/operations" data-action="open-queue">View job details</a>${button('dismiss-tracked-job','Dismiss','close')}</div>`:'';
  return accessBanner()+stopped+active.map(job=>`<div class="notice" role="status">${icon('pulse')}<span>${job.cancel_requested_at?'Stopping':job.status==='running'?'In progress':'Queued'} · ${esc(job.request?.kind==='explore'?job.request.target_url:job.parent_job_id?'Automatic fresh-browser reproduction':'Fresh-browser reproduction')}${job.job_id===state.trackedJobId?' · Your test will open here':''}</span>${job.run_id?`<a class="button" href="#/workspace/${esc(job.run_id)}">View run ${icon('arrow')}</a>`:''}${cancelButton('job',job)}</div>`).join('');
}
function parentJobLink(job){
  if(!job.parent_job_id)return '';
  const parent=state.jobs.find(j=>j.job_id===job.parent_job_id);
  return parent?.run_id?`<div><a class="button quiet" href="#/operations/${esc(parent.run_id)}">Parent exploration ${esc(short(job.parent_job_id))} ${icon('arrow')}</a></div>`:`<div>${button('job-lineage','Parent job '+short(job.parent_job_id),'flow',`data-id="${esc(job.job_id)}"`)}</div>`;
}
function automaticReason(reason){
  return {awaiting_queue:'Waiting for the browser queue',scheduled:'Fresh-browser check scheduled',case_limit:'Automatic check limit reached',action_limit:'Additional action budget exhausted',reviewed:'A human has already reviewed this finding',existing_attempt:'A reproduction already exists or is scheduled',source_unavailable:'The source exploration is no longer eligible',scope_unavailable:'The application is outside the current allowed origins',ineligible_assessment:'The assessment is not eligible for automatic reproduction',invalid_path:'The original path cannot be replayed',incomplete_path:'The original path has incomplete checks or evidence',session_unavailable:'The original saved sign-in session is unavailable',queue_capacity:'Waiting for room in the browser queue',queue_full:'Waiting for room in the browser queue',provider_unavailable:'Waiting for the configured model provider',gateway_unavailable:'Waiting for the model gateway',worker_unavailable:'Waiting for a browser worker',case_budget_exhausted:'Automatic check limit reached',action_budget_exhausted:'Additional action budget exhausted',replay_budget_exceeded:'This replay exceeds the remaining action budget',already_reproduced:'A reproduction already exists',reproduction_already_queued:'A reproduction is already queued',user_cancelled:'Automatic checks were stopped by the user',cancelled:'Automatic checks were stopped',source_cancelled:'The source exploration was cancelled',expectation_uncertain:'The expected result needs clarification',incomplete_evidence:'Complete source evidence is required',source_not_reviewable:'The source action is not eligible for reproduction',awaiting_source_completion:'Waiting for the source exploration to finish',ready:'Ready for a fresh-browser check'}[reason]||String(reason||'').replaceAll('_',' ');
}
function automaticTasks(){return state.report?.automatic_reproductions||[];}
function automaticTaskActive(task){
  if(task.status==='pending')return true;
  if(task.status!=='queued')return false;
  if(task.child_job)return ['queued','running'].includes(task.child_job.status);
  return !task.reproduction?.finished_at&&!['completed','failed','interrupted','blocked','cancelled'].includes(task.reproduction?.status);
}
function automaticTaskPill(task){
  if(task.status==='skipped')return '<span class="pill">Skipped</span>';
  if(task.status==='pending')return '<span class="pill amber">Waiting to queue</span>';
  const job=task.child_job;
  return pill(job?.cancel_id&&job.status==='running'?'cancelling':job?.status||task.reproduction?.status||'queued');
}
function automaticSourceLink(task,label='View source action'){
  return `<a class="button quiet" href="#/workspace/${esc(task.source_run_id)}/${esc(task.source_action_id)}" ${task.source_run_id===state.report?.run.run_id?`data-action="select-action" data-source-action="true" data-id="${esc(task.source_action_id)}"`:''}>${esc(label)} ${icon('arrow')}</a>`;
}
function automaticTaskView(task){
  const job=task.child_job,reproduction=task.reproduction,replayId=job?.run_id||reproduction?.replay_run_id;
  return `<article class="automatic-check"><div class="row">${automaticTaskPill(task)}<strong>Check source action ${esc(short(task.source_action_id))}</strong><span class="small muted">${number(task.planned_actions)} planned browser actions</span></div>${task.reason?`<p class="small muted">${esc(automaticReason(task.reason))}</p>`:''}${job?.error?`<p class="small review-error">${esc(job.error)}</p>`:''}<div class="row">${automaticSourceLink(task)}${replayId?`<a class="button" href="#/workspace/${esc(replayId)}">View reproduction ${icon('arrow')}</a>`:job?`<span class="small muted">Job ${esc(short(job.job_id))} · ${job.status==='cancelled'?'Cancelled before launch':'Awaiting worker'}</span>`:''}</div>${reproduction?.result?`<div class="automatic-result">${pill(reproduction.result.outcome)}<p class="small">${esc(reproduction.result.reason||'Recorded reproduction outcome')}</p></div>`:''}</article>`;
}
function automaticPanel(){
  const run=state.report?.run;if(!run)return '';
  const tasks=automaticTasks(),replay=run.config?.replay_of;
  if(replay){
    const task=tasks.find(t=>t.child_job?.run_id===run.run_id||t.reproduction?.replay_run_id===run.run_id);
    if(!task)return '';
    return `<section class="notice automatic-lineage">${icon('refresh')}<div><strong>Automatic fresh-browser check</strong><p class="small">This run rechecks a suspected bug from exploration ${esc(short(task.source_run_id))}. The outcome awaits human review.</p>${automaticSourceLink(task)}<a class="button quiet" href="#/operations/${esc(task.source_run_id)}">View parent exploration ${icon('arrow')}</a></div></section>`;
  }
  const policy=run.config?.automatic_reproduction_policy;
  if(!policy?.enabled&&!tasks.length)return '';
  const stopping=!!run.auto_reproduction_cancel_id||state.cancelling.has('automatic:'+run.run_id),planning=policy?.enabled&&!run.auto_reproduction_planned_at&&!run.auto_reproduction_cancelled_at&&['active','completed'].includes(run.lifecycle);
  const active=planning||tasks.some(automaticTaskActive),retryNeeded=!!run.auto_reproduction_cancel_id&&tasks.some(t=>automaticTaskActive(t)&&t.child_job&&!t.child_job.cancel_id&&!t.child_job.cancel_requested_at);
  return `<section class="panel automatic-panel"><div class="panel-header"><div><h2>Automatic checks</h2><p class="small muted">Up to ${number(policy?.max_cases)} suspected bugs · ${number(policy?.max_actions)} additional browser actions in total</p></div>${active?button('cancel-automatic',stopping?'Stopping automatic checks…':'Stop automatic checks','close',`data-id="${esc(run.run_id)}" ${stopping?'disabled':''}`):''}</div><div class="automatic-body"><p class="small muted">Fresh-browser outcomes preserve the original evidence. Human review is required to confirm a product defect.</p>${stopping||run.auto_reproduction_cancelled_at?`<p class="small" role="status">${active?'Stopping automatic checks.':'Automatic checks stopped.'} Recorded actions are retained; model calls already sent may still finish.</p>`:planning?'<p class="small" role="status">Waiting for exploration to finish and checks to be planned.</p>':''}${retryNeeded?`<div class="automatic-retry"><p class="small muted">A child stop request is still unacknowledged. Retrying uses the same cancellation.</p>${button('retry-automatic','Retry stop requests','refresh',`data-id="${esc(run.run_id)}" ${state.cancelling.has('automatic:'+run.run_id)?'disabled':''}`)}</div>`:''}${tasks.length?tasks.slice(0,12).map(automaticTaskView).join('')+(tasks.length>12?'<p class="small muted">Additional task records are available in the exported report.</p>':''):!planning&&!stopping?'<p class="small muted">No automatic replays were selected for this exploration.</p>':''}</div></section>`;
}
function replayControl(action,reproduction,eligible){
  const task=automaticTasks().find(t=>t.source_action_id===action.action_id&&automaticTaskActive(t));
  if(task)return `<div class="automatic-action-status">${automaticTaskPill(task)}<span class="small">Automatic fresh-browser check ${task.status==='pending'?'is waiting to queue':'is already scheduled'}.</span>${task.reason?`<span class="small muted">${esc(automaticReason(task.reason))}</span>`:''}${task.child_job?.run_id?`<a class="button" href="#/workspace/${esc(task.child_job.run_id)}">View reproduction ${icon('arrow')}</a>`:''}</div>`;
  if(reproduction)return `<a class="button" href="#/workspace/${esc(reproduction.replay_run_id)}">${icon('refresh')}View reproduction</a>`;
  if(eligible)return `<button class="button lime" data-action="reproduce" data-id="${esc(action.action_id)}" ${!canStart()||state.submitting?'disabled':''}>${icon('refresh')}Replay in fresh browser</button>`;
  return button('action-json','Inspect action','code');
}
async function cancelAutomatic(id){
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
function home(){
  const runs=workspaceRuns(),originals=state.runs.filter(r=>!r.config?.replay_of),pending=originals.reduce((sum,r)=>sum+Number(r.summary?.pending_findings||0),0);
  const confirmed=originals.reduce((sum,r)=>sum+Number(r.summary?.confirmed_findings||0),0),hasSummaries=originals.every(r=>r.summary);
  const filters=[['all','All runs'],['active','Running'],['needs_review','Needs review'],['completed','Completed'],['attention','Stopped / blocked']];
  return `<div class="page-heading"><div><div class="eyebrow">Explore with evidence</div><h1>Your QA workspace</h1><p>Start a test, follow its progress, and review what changed.</p></div><span class="pill">${state.providers.test_mode?'Simulated models':'Local workspace'}</span></div>${hero()}${workspaceSetup()}${jobBanner()}<div class="stats workspace-summary">${stat('Active runs',number(state.operations.active_runs),'Across this local workspace','pulse')}${stat('Findings to review',hasSummaries?number(pending):'—','Original explorations · latest 50 runs','bug')}${stat('Human confirmed',hasSummaries?number(confirmed):'—','Reviewer decisions · latest 50 runs','check')}${stat('Screenshots saved',state.operations.captures==null?'—':number(Number(state.operations.captures)+Number(state.operations.settling_frames||0)),'All local runs · includes test fixtures','image')}</div><section class="panel"><div class="panel-header"><div><h2>Recent explorations</h2><p class="small muted">${runs.length} of ${state.runs.length} loaded runs · latest 50 only</p></div><label class="search">${icon('search')}<span class="sr-only">Search runs</span><input id="run-search" type="search" placeholder="Search app, run or model…" value="${esc(state.search)}"></label></div><div class="run-toolbar"><div class="filter-group" aria-label="Filter runs">${filters.map(([value,label])=>`<button class="filter-chip ${state.runFilter===value?'active':''}" data-action="run-filter" data-value="${value}" aria-pressed="${state.runFilter===value}">${label}</button>`).join('')}</div><label class="small muted">Data <select id="run-mode"><option value="all" ${state.runMode==='all'?'selected':''}>All data</option><option value="live" ${state.runMode==='live'?'selected':''}>Live model runs</option><option value="test" ${state.runMode==='test'?'selected':''}>Test fixtures</option></select></label></div>${runs.length?`<div class="table-wrap"><table><thead><tr><th>Application / run</th><th>Status</th><th>Review</th><th>Actions</th><th>Started / duration</th><th><span class="sr-only">Open run</span></th></tr></thead><tbody>${runs.map(r=>`<tr><td><a class="table-link" href="#/workspace/${esc(r.run_id)}"><div class="table-title">${esc(name(r))}${fixture(r)?'<span class="tag">TEST DATA</span>':''}</div><div class="table-sub">${esc(short(r.run_id))} · ${esc(r.config?.viewport_profile||'desktop')} · ${r.config?.replay_of?'Reproduction':r.config?.runtime_version==='explorer-v1'?'Exploration':'Recorder fixture'}</div></a></td><td>${pill(runStatus(r))}</td><td>${r.config?.replay_of?'<span class="small muted">See source finding</span>':r.summary?Number(r.summary.pending_findings)>0?`<a class="pill amber" href="#/workspace/${esc(r.run_id)}" data-action="open-findings" data-id="${esc(r.run_id)}">${number(r.summary.pending_findings)} to review</a>`:Number(r.summary.confirmed_findings)>0?`<span class="pill green">${number(r.summary.confirmed_findings)} confirmed</span>`:'<span class="small muted">No pending candidates</span>':'<span class="small muted">Not loaded</span>'}</td><td>${number(r.summary?.actions)}</td><td class="muted">${date(r.created_at)}<div class="table-sub">${elapsed(r.created_at,r.finished_at)}</div></td><td><a class="button icon" href="#/workspace/${esc(r.run_id)}" aria-label="Open ${esc(name(r))}">${icon('arrow')}</a></td></tr>`).join('')}</tbody></table></div>`:empty(state.runs.length?'No runs match these filters':'Your first exploration starts here',state.runs.length?'Change the status, data filter or search to see more runs.':'Enter your application URL above. Scout will keep the actions and screenshots here.','search')}</section>`;
}
function mergeSteering(next,previous){
  if(!next)return previous;
  if(!previous)return next;
  if(next.revision<previous.revision)return previous;
  const messages=new Map(previous.messages.map(item=>[item.steering_id,item]));
  for(const item of next.messages){const saved=messages.get(item.steering_id);if(!saved||saved.status==='pending'||item.status!=='pending')messages.set(item.steering_id,item);}
  return {...next,messages:[...messages.values()].sort((a,b)=>a.revision-b.revision)};
}
function steeringDraft(id=state.runId){
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
function updateSteeringFocus(value){
  const draft=steeringDraft();if(draft.busy||draft.command)return false;
  draft.focus=value;draft.dirty=true;draft.error='';draft.message='';return true;
}
function steeringPanel(){
  const report=state.report,run=report?.run;
  if(!run||run.config.runtime_version!=='explorer-v1'||run.config.replay_of)return '';
  const snapshot=report.steering||{revision:0,messages:[]},draft=steeringDraft(),latest=snapshot.messages.at(-1);
  const applied=snapshot.active_focus||snapshot.messages.filter(m=>m.status==='applied').at(-1),active=run.lifecycle==='active'&&!run.cancel_requested_at;
  const labels={pending:'Waiting for next plan',applied:'Applied to planning',superseded:'Replaced before application',not_applied:'Not applied'};
  const conflict=draft.revision!==snapshot.revision&&!draft.command;
  return `<section class="panel steering-panel"><div class="panel-header"><div><h2>Testing focus</h2><p class="small muted">${applied?.focus?esc(applied.focus):'Explore likely user journeys'}</p></div>${latest?`<span class="pill ${latest.status==='applied'?'green':latest.status==='pending'?'blue':''}">${esc(labels[latest.status])}</span>`:''}</div><div class="steering-body"><p class="small muted">Change what Scout explores next. Focus applies at the next planning decision after the current action is assessed. Clearing it restores normal exploration.</p>${active||draft.command?`<form id="steering-form" data-run-id="${esc(run.run_id)}"><label for="steering-focus">What should Scout focus on?</label><textarea id="steering-focus" maxlength="2000" rows="2" placeholder="For example: focus on search, filtering, and opening a result" ${draft.busy||draft.command?'readonly':''}>${esc(draft.focus)}</textarea><p class="small muted">Existing action limits and access rules still apply. Keep credentials in the private sign-in window.</p>${conflict?'<p class="notice" role="status">The focus changed elsewhere. Review its history, then keep your edits or use the latest focus.</p>':''}${draft.error?`<p class="review-error" role="alert">${esc(draft.error)}</p>`:''}<div class="configuration-actions"><button type="submit" class="button primary" ${draft.busy||!draft.dirty||conflict||draft.focus.length>2000?'disabled':''}>${draft.busy?'Sending…':draft.command?'Retry same request':'Update focus'}</button>${!draft.command?`<button type="button" class="button" data-action="reset-steering" ${draft.busy?'disabled':''}>Use latest focus</button>${conflict?'<button type="button" class="button" data-action="rebase-steering">Keep my edits</button>':''}`:''}</div></form>`:'<p class="small muted">This exploration has ended. Any unapplied requests are retained in its history.</p>'}${draft.message?`<p class="small" role="status">${esc(draft.message)}</p>`:''}${snapshot.messages.length?`<details data-disclosure="steering-history"><summary>Focus history · ${snapshot.messages.length} changes</summary><ol class="steering-history">${snapshot.messages.map(item=>`<li><div class="row"><strong>Revision ${number(item.revision)}</strong><span class="pill">${esc(labels[item.status])}</span></div><p>${esc(item.focus||'Restore normal exploration')}</p><p class="small muted">${date(item.created_at)} · ${item.agent_id?'Agent '+esc(short(item.agent_id)):'Workspace user'}${item.status==='not_applied'?' · No further planning decision used this focus.':''}</p><span class="mono small">${esc(item.steering_id)}</span>${item.decision_id?`<p class="mono small">Planning decision ${esc(item.decision_id)}</p>`:''}</li>`).join('')}</ol></details>`:''}</div></section>`;
}
async function submitSteering(id=state.runId){
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
function workspaceRuns(){
  const search=state.search.toLowerCase().trim();
  return state.runs.filter(r=>{
    if(state.runMode==='test'&&!fixture(r)||state.runMode==='live'&&(fixture(r)||r.config?.execution_mode!=='live'))return false;
    if(state.runFilter==='needs_review'&&(!Number(r.summary?.pending_findings)||r.config?.replay_of))return false;
    if(state.runFilter==='attention'&&!['failed','interrupted','blocked','cancelled'].includes(r.lifecycle))return false;
    if(['active','completed'].includes(state.runFilter)&&r.lifecycle!==state.runFilter)return false;
    return [r.target_url,r.run_id,r.config?.model_connection?.model,r.config?.viewport_profile].join(' ').toLowerCase().includes(search);
  });
}
function workspaceSetup(){
  const provider=state.providers.providers.find(p=>p.provider===state.settings.provider),gateway=state.providers.gateway_ready===true,worker=state.workers.some(w=>w.available),model=!!provider?.configured&&!!state.settings.model;
  if(gateway&&worker&&model)return '';
  return `<section class="panel workspace-onboarding"><div class="panel-header"><div><h2>Ready to explore?</h2><p class="small muted">Recorded results remain available while you finish setup.</p></div><a class="button" href="#/operations" data-action="connections">${icon('globe')}View connections</a></div><div class="setup-checklist">${[[gateway,'Model gateway',gateway?'Ready for requests':'Waiting for the gateway'],[model,'Model connection',model?providerName(state.settings.provider)+' is configured':'Choose a provider and model in local configuration'],[worker,'Browser worker',worker?'Online and ready':'Waiting for the local worker']].map(([ready,label,description])=>`<div class="setup-step"><span class="step-status ${ready?'ready':'pending'}">${icon(ready?'check':'clock')}</span><div><strong>${label}</strong><p class="small muted">${esc(description)}</p></div></div>`).join('')}</div></section>`;
}
function actionName(action){const command=action.spec?.command;if(command?.type==='navigate')return 'Open application';const label=command?.control?.name||action.spec?.prediction?.goal||command?.type||'Browser action';return command?.type==='submit'?`Submit ${label}`:command?.type==='fill'?`Fill ${label}`:command?.type==='select'?`Select ${label}`:command?.type==='set_checked'?`${command.checked?'Check':'Uncheck'} ${label}`:label;}
function expected(action){return text(action.spec?.prediction?.expected_result??action.assessment?.expected??action.spec?.prediction?.expected);}
function selectedAction(){return state.report?.actions.find(a=>a.action_id===state.actionId);}
function findingReviews(action){const id=action.spec?.replay_source_action_id||action.action_id;return (state.report?.finding_reviews||[]).filter(r=>(r.action_id||r.source_action_id)===id).sort((a,b)=>Number(b.revision)-Number(a.revision));}
function latestReview(action){return findingReviews(action)[0];}
function findingStatus(action){return latestReview(action)?.disposition||'needs_review';}
function humanReviewPill(action){const status=findingStatus(action),labels={confirmed:['Human confirmed','green'],dismissed:['Human dismissed',''],needs_review:['Needs human review','amber']};const [label,color]=labels[status]||labels.needs_review;return `<span class="pill ${color}">${label}</span>`;}
function filteredFindings(){return (state.report?.actions||[]).filter(a=>a.assessment?.verdict==='suspect'&&(state.findingFilter==='all'||findingStatus(a)===(state.findingFilter||'needs_review')));}
function reviewable(action){const run=state.report?.run;return !!run&&run.config?.runtime_version==='explorer-v1'&&!run.config.replay_of&&['completed','failed','blocked','cancelled'].includes(run.lifecycle)&&action.state==='completed'&&action.assessment?.verdict==='suspect';}
function confirmable(action){
  if(!reviewable(action)||action.assessment?.expectation_uncertain)return false;
  const source=[action.before_capture_id,action.after_capture_id];
  if(source.some(id=>!id||!state.report.captures.some(c=>c.capture_id===id&&c.status==='available')))return false;
  return (state.report.reproductions||[]).some(r=>r.source_action_id===action.action_id&&r.result?.outcome==='reproduced'&&r.result.matching_after_state===true&&r.result.source_capture_ids?.length===2&&source.every(id=>r.result.source_capture_ids.includes(id))&&r.result.replay_capture_ids?.length===2&&r.result.replay_capture_ids.every(Boolean));
}
function reviewDraft(action){let draft=reviewDrafts.get(action.action_id);if(!draft){const latest=latestReview(action);draft={revision:latest?.revision||0,disposition:'needs_review',rationale:'',expectation_basis:latest?.expectation_basis||'',severity:latest?.severity||'',reviewId:null,submitting:false,error:''};reviewDrafts.set(action.action_id,draft);}return draft;}
function updateReviewDraft(id,field,value){const action=state.report?.actions.find(a=>a.action_id===id);if(!action||!['disposition','rationale','expectation_basis','severity'].includes(field))return;const draft=reviewDraft(action);if(draft.submitting)return;if(draft[field]!==value){draft[field]=value;draft.reviewId=null;draft.error='';}}
function reviewView(action){
  if(action.assessment?.verdict!=='suspect'&&!findingReviews(action).length)return '';
  const history=findingReviews(action),latest=history[0],allowed=reviewable(action),canConfirm=confirmable(action),draft=allowed?reviewDraft(action):null;
  return `<section class="panel finding-review"><div class="panel-header"><h2>Human review</h2>${humanReviewPill(action)}</div><div class="review-body"><p class="small muted">A reviewer decides whether the recorded behavior is a product defect. Original model assessments and evidence remain unchanged.</p>${latest?`<div class="review-current"><strong>Current review · revision ${number(latest.revision)}</strong><p>${esc(latest.rationale)}</p>${latest.expectation_basis?`<p><strong>Expectation basis:</strong> ${esc(latest.expectation_basis)}</p>`:''}<p class="small muted">${esc(latest.severity||'No severity')} · Reviewer ${esc(latest.reviewer_id)} · ${date(latest.created_at)}</p></div>`:'<p class="small">No human decision has been recorded.</p>'}${allowed?`<form class="review-form" id="finding-review-form" data-source-action="${esc(action.action_id)}"><fieldset ${draft.submitting?'disabled':''}><label for="review-disposition">Decision</label><select id="review-disposition" name="disposition" data-review-field="disposition" data-review-action="${esc(action.action_id)}">${[['needs_review','Needs further review'],['confirmed','Confirm product defect'],['dismissed','Dismiss candidate']].map(([value,label])=>`<option value="${value}" ${draft.disposition===value?'selected':''} ${value==='confirmed'&&!canConfirm?'disabled':''}>${label}</option>`).join('')}</select>${!canConfirm?'<p class="small muted">Confirmation requires a successful reproduction with a matching outcome, complete evidence and a clear original expectation. The server checks eligibility when saving.</p>':''}<label for="review-rationale">Reason for this decision</label><textarea id="review-rationale" name="rationale" data-review-field="rationale" data-review-action="${esc(action.action_id)}" required maxlength="2000" rows="3">${esc(draft.rationale)}</textarea><label for="review-expectation">Expectation basis${draft.disposition==='confirmed'?' (required)':''}</label><textarea id="review-expectation" name="expectation_basis" data-review-field="expectation_basis" data-review-action="${esc(action.action_id)}" ${draft.disposition==='confirmed'?'required minlength="10"':''} maxlength="2000" rows="3" placeholder="Explain the product requirement or user expectation that establishes the defect.">${esc(draft.expectation_basis)}</textarea><label for="review-severity">Severity${draft.disposition==='confirmed'?' (required)':''}</label><select id="review-severity" name="severity" data-review-field="severity" data-review-action="${esc(action.action_id)}" ${draft.disposition==='confirmed'?'required':''}><option value="">Choose severity</option>${['low','medium','high','critical'].map(value=>`<option value="${value}" ${draft.severity===value?'selected':''}>${value[0].toUpperCase()+value.slice(1)}</option>`).join('')}</select>${draft.error?`<p class="review-error" role="alert">${esc(draft.error)}</p>`:''}<p class="small muted">Saving appends revision ${number(Number(draft.revision)+1)}. Human review does not automatically qualify evidence for model training.</p><button class="button primary" type="submit" ${draft.submitting||draft.disposition==='confirmed'&&!canConfirm?'disabled':''}>${draft.submitting?'Saving review…':'Save human review'}</button></fieldset></form>`:'<p class="small muted">Review decisions are recorded on completed suspect actions in the original exploration run.</p>'}${history.length?`<details class="review-history" data-disclosure="review-${esc(action.action_id)}"><summary>Full review history · ${history.length} ${history.length===1?'decision':'decisions'}</summary>${history.map(item=>`<article><div class="row"><strong>Revision ${number(item.revision)}</strong><span class="pill">${esc({confirmed:'Human confirmed',dismissed:'Human dismissed',needs_review:'Needs human review'}[item.disposition]||item.disposition)}</span></div><p>${esc(item.rationale)}</p>${item.expectation_basis?`<p><strong>Expectation basis:</strong> ${esc(item.expectation_basis)}</p>`:''}<p class="small muted">Severity: ${esc(item.severity||'Not assigned')} · Reviewer ${esc(item.reviewer_id)} · ${date(item.created_at)}</p><span class="mono small">Review ${esc(item.review_id)}</span><details><summary>Evidence snapshot</summary>${json(item.evidence_snapshot)}</details></article>`).join('')}</details>`:''}</div></section>`;
}
async function submitReview(actionId){
  const action=state.report?.actions.find(a=>a.action_id===actionId);if(!action||!reviewable(action))return;
  const draft=reviewDraft(action);if(draft.submitting)return;
  if(!draft.rationale.trim()||draft.rationale.length>2000){draft.error='Enter a reason of 1–2,000 characters.';render();return;}
  if(draft.disposition==='confirmed'&&(!confirmable(action)||draft.expectation_basis.trim().length<10||!['low','medium','high','critical'].includes(draft.severity))){draft.error='Confirmation requires reproduced evidence, an expectation basis of at least 10 characters and a severity.';render();return;}
  draft.reviewId||=crypto.randomUUID();draft.submitting=true;draft.error='';render();
  const token=state.token,developmentAccess=state.developmentAccess,runId=state.runId;
  try{
    const result=await (await api('/v1/actions/'+encodeURIComponent(actionId)+'/reviews',{review_id:draft.reviewId,expected_revision:Number(draft.revision),disposition:draft.disposition,rationale:draft.rationale,expectation_basis:draft.expectation_basis,severity:draft.severity||null},{},55000)).json();
    if((token!==state.token||developmentAccess!==state.developmentAccess))return;
    if(state.runId===runId&&state.report){state.report.finding_reviews=[...(state.report.finding_reviews||[]).filter(r=>r.review_id!==result.review.review_id),result.review];}
    reviewDrafts.delete(actionId);toast(result.reused?'Showing the saved human review.':'Human review saved.');
  }catch(error){
    if((token!==state.token||developmentAccess!==state.developmentAccess))return;
    draft.error={review_id_conflict:'This submission ID belongs to different review content. Change the decision or reason to start a new submission.',reproduction_required:'A successful matching reproduction is required before confirmation.',incomplete_evidence:'The server could not verify complete evidence. Inspect the original run and reproduction before retrying.',evidence_checksum_mismatch:'Stored evidence failed its integrity check. Confirmation was not saved.',evidence_invalid_metadata:'Stored observation metadata failed its integrity check. Confirmation was not saved.',evidence_unavailable:'Evidence storage is unavailable. Your input is preserved; try again when it is available.',evidence_timeout:'Evidence verification timed out. Your input is preserved; retry to check whether this review was saved.',source_not_reviewable:'This action is not eligible for human review. Refresh the workspace to see its current status.'}[error.code]||error.message;
    if(error.code==='revision_conflict'||error.code==='revision_mismatch'){
      try{const report=await get('/v1/runs/'+runId);if((token!==state.token||developmentAccess!==state.developmentAccess))return;if(state.runId===runId)state.report=report;draft.revision=Math.max(0,...(report.finding_reviews||[]).filter(r=>(r.action_id||r.source_action_id)===actionId).map(r=>Number(r.revision)));draft.reviewId=null;draft.error='Another review was saved. The history has been refreshed and your input is preserved. Review the latest decision, then save again.';}catch{draft.error='The review changed, but refreshing failed. Your input is preserved. Refresh the workspace before retrying.';}
    }
  }finally{draft.submitting=false;if((token===state.token&&developmentAccess===state.developmentAccess))render();}
}
function runView(){
  if(!state.report)return '<div class="loading" role="status">Loading run evidence…</div>';
  const report=state.report,run=report.run,suspects=report.actions.filter(a=>a.assessment?.verdict==='suspect');
  const pending=suspects.filter(a=>findingStatus(a)==='needs_review'),confirmed=suspects.filter(a=>findingStatus(a)==='confirmed'),dismissed=suspects.filter(a=>findingStatus(a)==='dismissed');
  const actions=state.tab==='findings'?filteredFindings():report.actions;
  if(state.tab==='findings'&&!actions.some(a=>a.action_id===state.actionId))state.actionId=actions[0]?.action_id;
  const usage=report.model_usage||{},completed=report.actions.filter(a=>a.state==='completed').length;
  const limit=Number(run.config?.limits?.max_actions),executed=report.actions.filter(a=>a.dispatched_at||a.state==='completed').length;
  const description=run.cancel_requested_at&&run.lifecycle==='active'?'Stopping after the current in-flight work':run.config?.stop_reason?.replaceAll('_',' ')||(run.lifecycle==='active'?'Exploration in progress':'Recorded run finished');
  const progress=Number.isFinite(limit)&&limit>0?`<div class="run-progress"><div class="progress-label"><span>${number(executed)} of ${number(limit)} allowed actions used</span><span>Action budget · coverage is not a percentage</span></div><meter min="0" max="${limit}" value="${Math.min(executed,limit)}" aria-label="Browser action budget used">${executed} of ${limit}</meter></div>`:'';
  return `<div class="page-heading"><div><a class="button quiet" href="#/workspace">${icon('layers')}All explorations</a><div class="row"><span class="eyebrow">${run.config.replay_of?'Reproduction':'Exploration'} / ${esc(short(run.run_id))}</span>${fixture(run)?'<span class="tag">TEST DATA</span>':''}</div><h1>${esc(name(run))}</h1><p>${esc(run.config.viewport_profile||'desktop')} · ${date(run.created_at)} · ${elapsed(run.created_at,run.finished_at)}</p></div><div class="heading-actions">${pill(runStatus(run))}${cancelButton('run',run)}${button('export-run','Export report','download')}<a class="button" href="#/operations/${esc(run.run_id)}">${icon('pulse')}Inspect execution</a></div></div>${jobBanner()}${run.cancel_requested_at&&run.lifecycle==='active'?`<div class="notice" role="status">${icon('clock')}Stopping exploration. Recorded evidence is retained. The worker must acknowledge the request; model calls already sent may still finish.</div>`:''}${run.error?`<div class="notice ${run.lifecycle==='cancelled'?'':'error'}">${icon('info')}<span>${esc(run.error)}</span></div>`:''}<section class="panel run-summary"><div class="summary-cell"><span class="summary-label">Execution</span><strong class="summary-value">${esc(description)}</strong><span class="small muted">${completed} completed · ${report.actions.length} action records</span></div><div class="summary-cell"><span class="summary-label">Application</span><span class="small mono">${esc(run.target_url)}</span><span class="small muted">${esc(run.config.model_connection?.model||'Model not recorded')}</span></div>${progress}</section><div class="stats review-stats">${stat('Actions recorded',number(report.actions.length),`${completed} completed · other records may be pending or skipped`,'layers')}${stat('Findings to review',number(pending.length),`${number(dismissed.length)} human dismissed candidates`,'bug')}${stat('Human confirmed',number(confirmed.length),'Reviewer decisions, separate from AI suspicion','check')}${stat('Screenshots recorded',number(report.captures.length+(report.events||[]).filter(e=>e.event_type==='action.settling_frame').length),'Before, after and settling frames','image')}${stat('Model tokens',tokenTotal(usage),`${number(usage.attempts)} calls · ${number(usage.incomplete_usage_attempts||0)} incomplete usage records`,'bolt')}</div>${steeringPanel()}${fixVerificationPanel()}${automaticPanel()}<div class="tabs" role="tablist" aria-label="Run views">${[['actions','Actions','layers',report.actions.length],['findings','Findings','bug',suspects.length],['flow','Flow map','flow',report.graph?.states.length??0]].map(([tab,label,key,count])=>`<button id="run-tab-${tab}" class="tab ${state.tab===tab?'active':''}" role="tab" aria-selected="${state.tab===tab}" aria-controls="run-panel" tabindex="${state.tab===tab?'0':'-1'}" data-action="tab" data-value="${tab}">${icon(key)}${label}<span>${count}</span></button>`).join('')}</div><section id="run-panel" role="tabpanel" aria-labelledby="run-tab-${esc(state.tab)}" tabindex="0">${state.tab==='findings'?`<p class="view-description">All AI candidates remain recorded, including dismissed findings. Choose a status to review.</p><div class="finding-filters segmented" aria-label="Filter findings">${[['needs_review','Needs review',pending.length],['confirmed','Human confirmed',confirmed.length],['dismissed','Dismissed',dismissed.length],['all','All candidates',suspects.length]].map(([value,label,count])=>`<button data-action="finding-filter" data-value="${value}" class="${(state.findingFilter||'needs_review')===value?'active':''}" aria-pressed="${(state.findingFilter||'needs_review')===value}">${label} ${count}</button>`).join('')}</div>`:''}${state.tab==='flow'?flowView():actions.length?`<div class="run-layout"><aside class="action-list" aria-label="Recorded actions"><h3>${state.tab==='findings'?'Recorded candidates':'Action timeline'}<span>${actions.length} steps</span></h3>${actions.map(a=>`<button class="action-row ${state.actionId===a.action_id?'selected':''}" data-action="select-action" data-id="${esc(a.action_id)}" aria-pressed="${state.actionId===a.action_id}"><span class="step-number">${a.ordinal}</span><span class="step-copy"><h3>${esc(actionName(a))}</h3>${a.assessment?.verdict==='suspect'?`${humanReviewPill(a)}<span class="small muted model-suspicion">AI suspicion</span>`:pill(a.state==='cancelled'?'cancelled':a.assessment?.verdict||a.state)}<p>${esc(expected(a).slice(0,110))}</p></span></button>`).join('')}</aside><div class="action-detail">${actionDetail()}</div></div>`:state.tab==='findings'?empty('No findings in this filter','Switch filters to inspect other candidates. Recorded checks do not establish that the entire app is bug-free.','check'):empty('No actions recorded yet','The worker has not recorded an action for this run.','clock')}</section><div class="helper">${icon('info')}Coverage is bounded. Unvisited flows and unsupported interactions remain untested.</div>`;
}
function persistentIssueLink(action){
  const issue=state.report?.persistent_issues?.find(i=>i.action_id===action.action_id);
  const id=issue?.issue_id||state.report?.run?.config?.fix_verification?.issue_id;
  return id?`<div class="notice"><span>Issue ${esc(id)}</span><a class="button" href="/issues#${esc(id)}">History & verify fix</a></div>`:'';
}
function fixVerificationPanel(){
  const check=state.report?.fix_verification;if(!check)return '';
  const outcome={resolved:'Resolved on candidate',still_reproducible:'Still reproducible',blocked:'Blocked',inconclusive:'Inconclusive'}[check.outcome]||check.status;
  return `<section class="notice"><div><strong>Candidate fix verification · ${esc(outcome)}</strong><p>${esc(check.result?.reason||'Checking the original recorded behavior in a fresh browser.')}</p><p class="small muted">This result applies to this candidate deployment.</p></div><a class="button" href="/issues#${esc(check.issue_id)}">Issue history & both evidence sets</a></section>`;
}
function actionDetail(){
  const action=selectedAction();if(!action)return empty('Select an action','Open a recorded step to inspect its expectation and evidence.');
  const report=state.report,reproduction=report.reproductions.find(r=>r.source_action_id===action.action_id),isReplay=!!report.run.config.replay_of;
  const currentRepro=isReplay?report.reproductions.find(r=>r.replay_run_id===report.run.run_id):null;
  const captureId=state.image==='before'?action.before_capture_id:action.after_capture_id;
  const cap=report.captures.find(c=>c.capture_id===captureId);
  const mask=action.comparison?.raw_mask_artifact;
  const frame=(report.events||[]).find(e=>e.action_id===action.action_id&&e.event_type==='action.settling_frame'&&e.payload.frame_id===state.frameId)?.payload;
  const path=state.image==='frame'?(frame?`/v1/artifacts/${frame.artifact.artifact_id}/content`:null):state.image==='mask'?(mask?`/v1/artifacts/${mask.artifact_id}/content`:null):(cap?.status==='available'?`/v1/captures/${cap.capture_id}/image`:null);
  const id=state.image==='frame'?frame?.frame_id:state.image==='mask'?mask?.artifact_id:captureId;
  const active=['prepared','dispatched'].includes(action.state),capturePending=c=>c?.status==='failed'?false:active||['capturing','pending_upload'].includes(c?.status);
  const comparisonColumn=phase=>{
    const captureId=action[phase+'_capture_id'],capture=report.captures.find(c=>c.capture_id===captureId),label=phase==='before'?'Before action':'After action';
    return `<figure class="comparison-image"><figcaption><strong>${label}</strong><span class="small muted">Recorded screenshot</span></figcaption>${imagePanel(capture?.status==='available'?`/v1/captures/${capture.capture_id}/image`:null,`${phase} evidence for action ${action.ordinal}`,capturePending(capture))}<div class="image-label"><span class="mono">${esc(captureId||'No capture ID')}</span>${captureId?button('copy','Copy ID','copy',`data-value="${esc(captureId)}" aria-label="Copy ${phase} capture ID"`):''}</div></figure>`;
  };
  const evidence=state.image==='compare'?`<div class="evidence-comparison" role="group" aria-label="Before and after recorded screenshots">${comparisonColumn('before')}${comparisonColumn('after')}</div><p class="comparison-note">Screenshots are shown independently. Open either at full resolution to inspect its original pixels; changed pixels locate differences and do not establish a bug.</p>`:`${imagePanel(path,`${state.image} evidence for action ${action.ordinal}`,state.image==='before'||state.image==='after'?capturePending(cap):active)}<div class="image-label"><span class="mono">${esc(id||'No capture ID')}</span>${id?button('copy','Copy ID','copy',`data-value="${esc(id)}"`):''}</div>`;
  const navigationActions=state.tab==='findings'?filteredFindings():report.actions,index=navigationActions.findIndex(a=>a.action_id===action.action_id);
  const previous=index>0?navigationActions[index-1]:null,next=index>=0?navigationActions[index+1]:null;
  const navigation=index<0?'':`<nav class="action-navigation" aria-label="Recorded action navigation"><button type="button" class="button" data-action="prev-action" data-id="${esc(previous?.action_id||'')}" aria-label="Previous recorded action" ${previous?'':'disabled'}>${icon('chevron')}Previous</button><span class="small muted" aria-live="polite">Action ${index+1} of ${navigationActions.length}${state.tab==='findings'?' in this filter':''}</span><button type="button" class="button" data-action="next-action" data-id="${esc(next?.action_id||'')}" aria-label="Next recorded action" ${next?'':'disabled'}>Next${icon('chevron')}</button></nav>`;
  const eligible=action.assessment?.verdict==='suspect'&&!action.assessment.expectation_uncertain&&report.run.config.runtime_version==='explorer-v1'&&!isReplay&&report.run.lifecycle!=='active';
  return `${navigation}${persistentIssueLink(action)}<section class="panel"><div class="detail-heading"><div><span class="eyebrow">Action ${action.ordinal}</span><h2>${esc(actionName(action))}</h2><div class="small muted">${esc(short(action.action_id))} · ${esc(action.assessment?.method==='deterministic-fixture-v1'?'Fixture-defined check':'Model assessment')}</div></div>${action.assessment?.verdict==='suspect'?`<div>${humanReviewPill(action)}<span class="small muted model-suspicion">Original AI suspicion</span></div>`:pill(action.assessment?.verdict||action.state)}</div><div class="expectations"><div class="expectation"><div class="eyebrow">Expected before acting</div>${esc(expected(action))}</div><div class="expectation"><div class="eyebrow">Observed result</div>${esc(text(action.assessment?.observed_result??action.assessment?.actual??action.assessment?.reason??'Waiting for assessment'))}</div></div><div class="evidence-top"><div class="segmented" aria-label="Screenshot view">${['before','after','compare','mask'].map(view=>`<button type="button" class="${state.image===view?'active':''}" data-action="image" data-value="${view}" aria-pressed="${state.image===view}">${view==='mask'?'Difference mask':view==='compare'?'Compare':view[0].toUpperCase()+view.slice(1)}</button>`).join('')}</div><span class="pill">${number(action.comparison?.counts?.changed_pixels)} changed pixels</span></div>${evidence}${outcomeView(action)}${action.assessment?.reason?`<div class="expectation"><div class="eyebrow">Assessment</div>${esc(action.assessment.reason)}</div>`:''}<div class="detail-footer"><p>Original evidence is preserved. A model assessment is not a confirmed product defect.</p>${replayControl(action,reproduction,eligible)}</div></section>${reproduction||currentRepro?`<div class="callout">${pill((reproduction||currentRepro).result?.outcome||'running')} <strong>Reproduction result</strong><p>${esc((reproduction||currentRepro).result?.reason||'Fresh-browser verification is in progress.')}</p>${isReplay?`<a class="button quiet" href="#/workspace/${esc(report.run.config.replay_of.source_run_id)}">View original run ${icon('arrow')}</a>`:''}</div>`:''}${reviewView(action)}`;
}
function outcomeView(action){
  const frames=(state.report.events||[]).filter(e=>e.action_id===action.action_id&&e.event_type==='action.settling_frame').map(e=>e.payload);
  if(!action.outcome&&!frames.length)return '';
  const outcome=action.outcome||{status:state.report.run.lifecycle==='active'?'collecting':'incomplete',reason:'Completion metadata is not available yet. The recorded samples remain inspectable.'};
  const problems=(outcome.diagnostic_events||[]).filter(e=>e.kind==='page_error'||e.kind==='console'||e.kind==='request_failed'||e.kind==='response'&&e.status>=400);
  return `<details class="outcome-panel" data-disclosure="outcome-${esc(action.action_id)}"><summary>Action completion · ${outcome.status==='settled'?'Settled':outcome.status==='collecting'?'Collecting':'Unresolved'} · ${number(outcome.elapsed_ms)} ms</summary><p class="small">${esc(outcome.reason)}</p><div class="row"><span class="pill">${number(outcome.diagnostics?.http_errors)} HTTP errors</span><span class="pill">${number(outcome.diagnostics?.request_failures)} request failures</span><span class="pill">${number(outcome.diagnostics?.console_errors)} browser errors</span></div><p class="small muted">${frames.length} sampled screenshots · ${number(outcome.visual_changes)} visual changes · ${number(outcome.pending_requests)} requests still pending${outcome.diagnostics?.dropped_events?' · Diagnostic log truncated':''}</p><div class="settling-frames">${frames.map(frame=>`<button class="button quiet ${state.frameId===frame.frame_id&&state.image==='frame'?'selected':''}" data-action="settling-frame" data-id="${esc(frame.frame_id)}">${number(frame.offset_ms)} ms</button>`).join('')}</div>${problems.map(e=>`<p class="diagnostic-entry"><span class="mono">${number(e.offset_ms)} ms · ${esc(e.kind)}</span><br>${esc(e.status?`HTTP ${e.status} ${e.url}`:e.text||e.error)}</p>`).join('')}${button('outcome-json','Inspect completion and diagnostics','code')}<p class="small muted">A quiet observation is bounded evidence. Request and browser errors support the assessment; they do not automatically confirm a bug.</p></details>`;
}
function planningView(graph){
  const latest=graph.selections?.at(-1);
  if(!latest)return '';
  const label=id=>'S'+(graph.states.findIndex(s=>s.state_id===id)+1);
  const rows=(latest.ranked_paths||[]).map(path=>`<tr><td><strong>${esc(path.name)}</strong><div class="table-sub">${path.path_state_ids.map(label).join(' → ')} → ${esc(path.name)}</div></td><td>${Math.round(path.likelihood*100)}/100</td><td>${Math.round((path.path_likelihood_score??path.path_likelihood_estimate)*100)}/100</td><td>${path.travel_steps}</td><td>${esc(path.reason)}</td></tr>`).join('');
  const states=graph.states.filter(s=>s.url!=='about:blank');
  const renderNode=(node,seen=new Set())=>{
    if(seen.has(node.state_id))return '';
    const visited=new Set([...seen,node.state_id]);
    const children=states.filter(s=>s.planning?.parent_state_id===node.state_id);
    const remaining=graph.frontier.filter(f=>f.state_id===node.state_id&&f.status==='unexplored').length;
    return `<li><div><span class="pill">${label(node.state_id)}</span><strong>${esc(node.url)}</strong><span class="small muted">${remaining} unvisited controls</span></div>${children.length?`<ul>${children.map(child=>renderNode(child,visited)).join('')}</ul>`:''}</li>`;
  };
  return `<section class="panel planner-panel"><div class="panel-header"><h2>Latest planning decision</h2><span class="pill">${latest.purpose==='return'?'Returning to a branch':'Exploring a new step'}</span></div><div class="planner-explanation"><strong>${esc(latest.selected.name)}</strong><p>${esc(latest.selected.reason)}</p><p class="small muted">Scores rank hypotheses about user intent; they are not measured probabilities. The path score multiplies scores along the discovery path. Changed pixels help choose what to inspect; they do not establish a bug.</p></div><div class="table-wrap"><table><thead><tr><th>Candidate journey</th><th>Next-action score</th><th>Path score</th><th>Return steps</th><th>Why explore it</th></tr></thead><tbody>${rows}</tbody></table></div></section><section class="panel settings-panel"><h2>Discovery tree</h2><p class="small muted">First-discovery relationships are shown here. Return routes and cycles remain in the transition graph below.</p><ul class="discovery-tree">${states.filter(s=>!states.some(parent=>parent.state_id===s.planning?.parent_state_id)).map(node=>renderNode(node)).join('')}</ul></section>`;
}
function flowView(){
  const graph=state.report.graph;if(!graph)return empty('No exploration graph','This recorder fixture has an action timeline but no model exploration graph.','flow');
  const nodeName=id=>'S'+(graph.states.findIndex(n=>n.state_id===id)+1);
  return `${planningView(graph)}<div class="flow-grid">${graph.states.map((node,index)=>{const controls=graph.frontier.filter(f=>f.state_id===node.state_id);return `<article class="state-card"><span class="pill">State ${index+1}</span><strong>${esc(node.url)}</strong><p class="small muted">${controls.filter(f=>f.status==='attempted').length} attempted · ${controls.filter(f=>f.status==='unexplored').length} unexplored · ${controls.filter(f=>f.status==='blocked').length} blocked</p><p class="mono">${esc(node.state_id)}</p></article>`;}).join('')}</div><section class="panel"><div class="panel-header"><h2>Executed transitions</h2><span class="small muted">Exact screenshot and page-state identity</span></div><div class="table-wrap"><table><thead><tr><th>Transition</th><th>Action</th><th>Assessment</th><th></th></tr></thead><tbody>${graph.edges.map(edge=>{const action=state.report.actions.find(a=>a.action_id===edge.action_id);return `<tr><td><div class="transition"><span>${nodeName(edge.from_state_id)}</span>${icon('arrow')}<span>${nodeName(edge.to_state_id)}</span>${edge.from_state_id===edge.to_state_id?'<small class="muted">Same state</small>':''}</div></td><td>${esc(action? actionName(action):short(edge.action_id))}</td><td>${pill(action?.assessment?.verdict)}</td><td>${button('select-action','Evidence','image',`data-id="${edge.action_id}"`)}</td></tr>`;}).join('')}</tbody></table></div></section><section class="panel settings-panel"><h2>Unvisited and blocked controls</h2>${graph.frontier.filter(f=>f.status!=='attempted').map(f=>`<div class="key-value"><span>${esc(f.control.name)} <small>${nodeName(f.state_id)}</small></span><span>${esc((f.reason||f.status).replaceAll('_',' '))}</span></div>`).join('')||'<p class="small muted">No additional controls were recorded in these states.</p>'}</section>`;
}
function picker(){return `<label class="row small muted">Inspect a run <select id="ops-run" class="run-picker"><option value="">Choose a run</option>${state.runs.map(r=>`<option value="${esc(r.run_id)}" ${r.run_id===state.runId?'selected':''}>${esc(name(r))} · ${esc(short(r.run_id))}</option>`).join('')}</select></label>`;}
function operations(){
  const views={overview:opsOverview,jobs:jobsView,models:modelsView,events:eventsView,connections:connections};
  const selected=Object.keys(views).includes(state.opsTab)?state.opsTab:'overview';
  return `<div class="page-heading backoffice-heading"><div><div class="eyebrow">Back office</div><h1>Operations</h1><p>Monitor the worker, investigate queued work, and trace model calls to their evidence.</p><p class="small muted">${state.lastUpdatedAt?`Last refreshed ${esc(date(state.lastUpdatedAt))}`:'Waiting for a workspace status snapshot.'}</p></div>${picker()}</div><div class="tabs backoffice-nav" role="tablist" aria-label="Operations views">${[['overview','Overview','pulse'],['jobs','Browser jobs','layers'],['models','Model calls','bolt'],['events','Event log','code'],['connections','Connections','database']].map(([tab,label,key])=>`<button id="ops-tab-${tab}" class="tab ${selected===tab?'active':''}" role="tab" aria-selected="${selected===tab}" aria-controls="ops-panel" tabindex="${selected===tab?'0':'-1'}" data-action="ops-tab" data-value="${tab}">${icon(key)}${label}</button>`).join('')}</div><section id="ops-panel" role="tabpanel" aria-labelledby="ops-tab-${selected}" tabindex="0">${views[selected]()}</section>`;
}
function opsOverview(){
  const o=state.operations||{},usage=state.usage||{},online=state.workers.filter(w=>w.available===true).length;
  const sum=(...values)=>values.every(v=>v!=null&&Number.isFinite(Number(v)))?values.reduce((total,v)=>total+Number(v),0):null;
  const uploads=sum(o.pending_captures,o.pending_artifacts,o.pending_model_payloads),events=sum(o.pending_runtime_events,o.pending_model_events);
  const providers=state.providers.providers||[],selected=providers.find(p=>p.provider===state.settings.provider),recent=state.jobs.slice(0,50);
  const queued=recent.filter(j=>j.status==='queued').length,failed=recent.filter(j=>['failed','interrupted','blocked'].includes(j.status)).length,attention=[];
  if(!online)attention.push(['Browser worker unavailable',queued?`${queued} queued jobs in the latest ${recent.length} records are waiting. Check the worker process and heartbeat.`:'No worker has a recent online heartbeat. Recorded evidence remains available.','jobs']);
  if(state.providers.gateway_ready!==true)attention.push(['Model gateway not ready',state.providers.gateway_ready===false?'The local model dispatcher is not ready. New inference cannot start yet.':'The gateway has not reported readiness. Refresh to obtain its current status.','connections']);
  if(!selected?.configured||!state.settings.model)attention.push(['Exploration model needs configuration',`Select a configured provider and model before starting exploration. Current provider: ${providerName(state.settings.provider)}.`,'connections']);
  if(Number(o.failed_captures)>0)attention.push(['Recorded capture failures',`${number(o.failed_captures)} capture records failed. Inspect the affected run before relying on its evidence.`,'events']);
  if(uploads>0)attention.push(['Evidence awaiting delivery',`${number(uploads)} captures, artifacts or model payloads remain in the upload outbox. A backlog alone does not diagnose a bucket outage.`,'overview']);
  if(events>0)attention.push(['Events awaiting delivery',`${number(events)} runtime and model events remain in the export outbox. Their durable records are retained for delivery.`,'events']);
  if(failed)attention.push(['Browser jobs need inspection',`${failed} failed, interrupted or access-blocked jobs appear in the latest ${recent.length} records.`,'jobs']);
  const service=(title,status,description,color='')=>`<article class="service-card"><h2 class="service-label">${esc(title)}</h2><span class="service-state pill ${color}">${esc(status)}</span><p class="service-meta small muted">${esc(description)}</p></article>`;
  return `<div class="ops-status-grid">${service('Browser workers',online?`${online} online`:'No recent heartbeat','Availability requires an online heartbeat within 20 seconds.',online?'green':'amber')}${service('Model gateway',state.providers.gateway_ready===true?'Dispatcher ready':state.providers.gateway_ready===false?'Not ready':'Unknown',`${providers.filter(p=>p.configured).length} configured provider connections. Readiness is the local dispatcher state, not a live provider check.`,state.providers.gateway_ready===true?'green':'amber')}${service('Evidence delivery',uploads==null?'Unknown':uploads?`${number(uploads)} pending`:'No pending uploads','Database upload-outbox snapshot; bucket health is not directly probed.',uploads==null||uploads?'amber':'')}${service('Event delivery',events==null?'Unknown':events?`${number(events)} pending`:'No pending events','Database export-outbox snapshot; ClickHouse health is not directly probed.',events==null||events?'amber':'')}</div><section class="panel ops-attention"><div class="panel-header"><h2>Needs attention</h2><span class="small muted">${attention.length?`${attention.length} signals`:'No attention signals in this snapshot'}</span></div>${attention.map(([title,description,tab])=>`<div class="signal-row"><span class="attention-icon">${icon('info')}</span><div class="attention-copy"><strong>${esc(title)}</strong><p class="small muted">${esc(description)}</p></div>${button('ops-tab','Inspect','arrow',`data-value="${tab}"`)}</div>`).join('')||'<p class="small muted section-copy">The current worker, configuration and delivery counters have no flagged conditions. This is not a full service-health test.</p>'}</section><div class="stats">${stat('Active runs',number(o.active_runs),'Workspace execution records','pulse')}${stat('Pending event delivery',events==null?'Unknown':number(events),'Runtime and model events → ClickHouse','database')}${stat('Model tokens',tokenTotal(usage),`${opsMode(usage.execution_mode)} · ${number(usage.incomplete_usage_attempts)} incomplete usage records`,'bolt')}${stat('Reported cost',costTotal(usage),`${number(usage.unpriced_attempts)} attempts without reported cost`,'clock')}</div><div class="ops-grid"><section class="panel pipeline"><h2>Evidence delivery</h2>${kv('Before / after captures',number(o.captures))}${kv('Settling frames recorded',number(o.settling_frames))}${kv('Captures awaiting upload',number(o.pending_captures))}${kv('Capture failures',number(o.failed_captures))}${kv('Artifacts awaiting upload',number(o.pending_artifacts))}${kv('Model payloads awaiting upload',number(o.pending_model_payloads))}</section><section class="panel pipeline"><h2>Execution & observability</h2>${kv('PostgreSQL',o.database==='reachable'?'Reachable at snapshot':o.database||'Not reported')}${kv('Runs currently active',number(o.active_runs))}${kv('Runs with execution failures',number(o.failed_runs))}${kv('Runtime events recorded',number(o.runtime_events))}${kv('Latest runtime export',date(o.last_runtime_export))}${kv('Persistent issues',number(o.issues))}${kv('Candidate fix checks',number(o.candidate_checks))}${kv('Pending issue history exports',number(o.pending_issue_events))}${kv('Snapshot captured',date(o.as_of))}</section></div><div class="notice">${icon('info')}The usage ledger separates live calls from simulated test calls. Missing token or cost reports stay unknown. Queue counts below cover the latest 50 returned jobs.</div>${jobsView(true)}`;
}
function kv(key,value){return `<div class="key-value"><span>${esc(key)}</span><span>${esc(value)}</span></div>`;}
function opsMode(mode){return mode==='protocol_fixture'?'Simulated':mode==='live'?'Live':'Unknown mode';}
function jobsView(compact=false){
  const recent=state.jobs.slice(0,50),search=String(state.jobSearch||'').toLowerCase(),filter=state.jobFilter||'all',mode=state.jobMode||'all';
  const statusMatches=job=>filter==='all'||filter==='attention'&&['failed','interrupted','blocked'].includes(job.status)||job.status===filter;
  const jobs=compact?recent.slice(0,5):recent.filter(job=>statusMatches(job)&&(mode==='all'||job.execution_mode===mode)&&[job.job_id,job.run_id,job.parent_job_id,job.status,job.execution_mode,job.request?.kind,job.request?.target_url,job.request?.source_action_id,job.error,job.settings?.provider,job.settings?.model].join(' ').toLowerCase().includes(search));
  const controls=compact?'':`<div class="queue-toolbar"><label class="search">${icon('search')}<span class="sr-only">Search browser jobs</span><input id="job-search" placeholder="Search URL, job ID or error…" value="${esc(state.jobSearch||'')}"></label><label class="small muted">Status <select id="job-filter" data-action="job-filter">${[['all','All statuses'],['queued','Queued'],['running','Running'],['attention','Needs attention'],['completed','Completed'],['cancelled','Cancelled'],['failed','Failed'],['interrupted','Interrupted'],['blocked','Needs access']].map(([value,label])=>`<option value="${value}" ${filter===value?'selected':''}>${label}</option>`).join('')}</select></label><label class="small muted">Mode <select id="job-mode" data-action="job-mode">${[['all','All modes'],['live','Live'],['protocol_fixture','Simulated']].map(([value,label])=>`<option value="${value}" ${mode===value?'selected':''}>${label}</option>`).join('')}</select></label></div><p class="small muted section-copy">Showing ${jobs.length} of the latest ${recent.length} jobs returned by the server (maximum 50). Filters do not search older history.</p>`;
  return `<section class="panel"><div class="panel-header"><div><h2>${compact?'Recent browser jobs':'Browser job queue'}</h2><p class="small muted">${compact?'Latest five of the latest 50 returned records':'Queue admission, worker execution and retained results'}</p></div><span class="small muted">One worker · idempotent admission</span></div>${controls}${jobs.length?`<div class="table-wrap"><table><thead><tr><th>Job</th><th>Status / worker</th><th>Mode</th><th>Created / elapsed</th><th>Result</th></tr></thead><tbody>${jobs.map(job=>{const request=job.request||{},target=request.target_url||request.source_action_id;return `<tr><td><div class="table-title">${request.kind==='verify_fix'?'Verify candidate fix':request.kind==='explore'?'Explore application':job.parent_job_id?'Automatic reproduction':'Reproduce finding'}</div><div class="table-sub" title="${esc(target||job.job_id)}">${esc(request.target_url||short(request.source_action_id))}</div><span class="mono muted">${esc(short(job.job_id))}</span>${parentJobLink(job)}${job.error?`<div class="table-sub" title="${esc(job.error)}">${esc(job.error)}</div>`:''}</td><td>${pill(job.cancel_requested_at&&job.status==='running'?'cancelling':job.status)}<div class="table-sub mono">${job.worker_id?esc(short(job.worker_id)):'No worker assigned'}</div></td><td class="muted">${opsMode(job.execution_mode)}</td><td class="muted">${esc(date(job.created_at))}<div class="table-sub">${job.started_at?`${esc(elapsed(job.started_at,job.finished_at))} since start`:job.status==='queued'?'Not started':'Not launched'}</div></td><td><div class="table-actions">${job.run_id?`<a class="button" href="#/workspace/${esc(job.run_id)}">Open run ${icon('arrow')}</a>`:job.error?button('job-error','Details','info',`data-id="${esc(job.job_id)}"`):`<span class="muted">${job.status==='cancelled'?'Cancelled before launch':job.status==='queued'?'Awaiting worker':job.status==='running'?'Starting browser':'No run recorded'}</span>`}${cancelButton('job',job)}</div></td></tr>`;}).join('')}</tbody></table></div>`:empty(recent.length?'No matching browser jobs':'No queued browser jobs',recent.length?'Adjust the status, mode or search filters. Only the latest 50 returned jobs are searchable.':'Start an exploration in the workspace to see admission, execution and results here. CLI runs remain available in the run picker.')}</section>`;
}
function modelPurpose(request){return state.report?.graph?.decisions?.find(d=>d.request_id===request.request_id)?.kind||state.report?.events?.find(e=>e.event_type==='model.decision_requested'&&e.payload?.request_id===request.request_id)?.payload?.kind||'inference';}
function modelsView(){
  if(!state.report)return empty('Choose a run','Select a run above to inspect its provider requests, responses and recorded usage.','bolt');
  const report=state.report,all=report.model_requests||[],search=String(state.modelSearch||'').toLowerCase(),provider=state.modelProvider||'all',status=state.modelStatus||'all',purpose=state.modelPurpose||'all',usage=report.model_usage||{};
  const requests=all.filter(r=>(provider==='all'||r.provider===provider)&&(status==='all'||r.state===status)&&(purpose==='all'||modelPurpose(r)===purpose)&&[r.request_id,r.action_id,r.provider,r.model,r.state,modelPurpose(r),r.error].join(' ').toLowerCase().includes(search));
  const select=(id,label,selected,values)=>`<label class="small muted">${label} <select id="model-${id}" data-action="model-filter" data-field="${id}"><option value="all">All ${label.toLowerCase()}s</option>${[...new Set(values)].map(value=>`<option value="${esc(value)}" ${selected===value?'selected':''}>${esc(id==='provider'?providerName(value):String(value).replaceAll('_',' '))}</option>`).join('')}</select></label>`;
  const totals=r=>{const calls=(report.model_calls||[]).filter(c=>c.request_id===r.request_id),sum=key=>calls.some(c=>c[key]!=null)?calls.reduce((n,c)=>n+Number(c[key]??0),0):null;return {known_input_tokens:sum('input_tokens'),known_output_tokens:sum('output_tokens'),incomplete_usage_attempts:calls.filter(c=>c.usage_status!=='reported'||c.input_tokens==null||c.output_tokens==null).length};};
  return `<section class="panel settings-panel"><div class="panel-header"><div><h2>Model activity for this run</h2><p class="small muted">${esc(name(report.run))} · ${esc(opsMode(report.run.config?.execution_mode))} · ${esc(short(report.run.run_id))}</p></div><a class="button" href="#/workspace/${esc(report.run.run_id)}">Open run ${icon('arrow')}</a></div><div class="stats">${stat('Logical requests',number(all.length),'Each request has a stable ID','bolt')}${stat('Recorded attempts',number((report.model_calls||[]).length),'Provider calls, including incomplete attempts','layers')}${stat('Run model tokens',tokenTotal(usage),'Known subtotal; missing usage stays unknown','bolt')}${stat('Run reported cost',costTotal(usage),'Only provider-reported cost','clock')}</div><p class="small muted">Usage totals cover this whole run and do not change with the filters below. Live and simulated calls are identified on each row.</p></section><section class="panel"><div class="panel-header"><h2>Model requests</h2><span class="small muted">${requests.length} of ${all.length} logical requests · attempts are recorded separately</span></div><div class="queue-toolbar"><label class="search">${icon('search')}<span class="sr-only">Search model requests</span><input id="model-search" placeholder="Search model, request ID or error…" value="${esc(state.modelSearch||'')}"></label>${select('provider','Provider',provider,['openai','anthropic','openrouter',...all.map(r=>r.provider).filter(Boolean)])}${select('status','State',status,['queued','preparing','dispatched','completed','failed','interrupted','cancelled',...all.map(r=>r.state).filter(Boolean)])}${select('purpose','Purpose',purpose,['navigation_prediction','plan','assessment','inference',...all.map(modelPurpose)])}</div>${requests.length?`<div class="table-wrap"><table><thead><tr><th>Request / purpose</th><th>Provider / model</th><th>Mode / status</th><th>Attempts</th><th>Duration</th><th>Reported tokens</th><th></th></tr></thead><tbody>${requests.map(r=>`<tr><td><button class="table-link" data-action="model" data-id="${esc(r.request_id)}"><div class="table-title">${esc(modelPurpose(r).replaceAll('_',' '))}</div><div class="table-sub mono">${esc(short(r.request_id))}</div></button>${r.action_id?`<a class="table-sub" href="#/workspace/${esc(report.run.run_id)}/${esc(r.action_id)}">Action ${esc(short(r.action_id))}</a>`:'<div class="table-sub">Run-level decision</div>'}${r.error?`<div class="table-sub" title="${esc(r.error)}">${esc(r.error)}</div>`:''}</td><td>${esc(providerName(r.provider))}<div class="table-sub">${esc(r.model)}</div></td><td><span class="table-sub">${opsMode(r.execution_mode)}</span>${pill(r.state)}</td><td>${esc(number(r.attempt_count))}</td><td class="muted">${esc(elapsed(r.created_at,r.finished_at))}</td><td>${esc(tokenTotal(totals(r)))}</td><td>${button('model','Inspect','code',`data-id="${esc(r.request_id)}"`)}</td></tr>`).join('')}</tbody></table></div>`:empty(all.length?'No matching model requests':'No model calls',all.length?'Adjust the provider, state, purpose or search filters. These filters apply only to the selected run.':'No model requests are recorded for this run. Recorder-only runs and jobs stopped before inference can have no model calls.','bolt')}</section>`;
}
function eventsView(){
  if(!state.report)return empty('Choose a run','Select a run above to inspect its ordered execution events.','code');
  const all=state.report.events||[],search=String(state.eventSearch||'').toLowerCase(),events=all.filter(e=>[e.event_type,e.action_id,e.event_id,e.seq].join(' ').toLowerCase().includes(search));
  return `<section class="panel"><div class="panel-header"><div><h2>Execution event log <span class="small muted">${events.length} of ${all.length} events</span></h2><p class="small muted">Ordered runtime events for ${esc(short(state.report.run?.run_id))}. Provider request and response details are in Model calls.</p></div><label class="search">${icon('search')}<span class="sr-only">Filter events</span><input id="event-search" placeholder="Filter type, sequence or ID…" value="${esc(state.eventSearch||'')}"></label></div><div class="event-list">${events.map(e=>`<details class="event" data-event="${esc(e.event_id)}" ${state.expanded.has(e.event_id)?'open':''}><summary><span class="mono">#${esc(e.seq)}</span><strong>${esc(e.event_type)}</strong><time>${esc(date(e.occurred_at))}</time>${icon('chevron')}</summary>${e.action_id?`<p class="small">Action <a class="mono" href="#/workspace/${esc(state.report.run?.run_id)}/${esc(e.action_id)}">${esc(e.action_id)}</a></p>`:''}${json(e)}</details>`).join('')||empty(all.length?'No matching events':'No execution events',all.length?'Try another event type, sequence or ID.':'This run has no recorded runtime events in the current report.','code')}</div></section>`;
}
function configurationValues(settings=state.settings){
  return {provider:settings.provider||'openrouter',model:settings.model||'',max_actions:settings.maxActions??6,viewport_profile:settings.viewportProfile||'desktop',free_only:settings.provider==='openrouter'&&settings.freeOnly===true,auto_reproduce:settings.autoReproduce===true,max_auto_reproductions:settings.maxAutoReproductions??2,max_auto_replay_actions:settings.maxAutoReplayActions??12};
}
function configurationDraft(){
  const values=configurationValues(),fingerprint=JSON.stringify(values),old=state.configurationDraft;
  if(!old||!old.dirty&&!old.saving&&(old.revision!==state.settingsRevision||old.fingerprint!==fingerprint)){
    state.configurationDraft={values,revision:state.settingsRevision,fingerprint,dirty:false,saving:false,requestId:null,error:'',message:old?.message||'',models:{[values.provider]:values.model}};
  }
  return state.configurationDraft;
}
function configurationError(values){
  if(!['openai','anthropic','openrouter'].includes(values.provider))return 'Choose a supported provider.';
  if(typeof values.model!=='string'||/[\x00-\x1f\x7f]/.test(values.model)||! /^[A-Za-z0-9/:._-]{1,200}$/.test(values.model.trim()))return 'Enter a model ID using letters, numbers, / : . _ or - (up to 200 characters).';
  for(const [key,max,label] of [['max_actions',12,'Maximum actions'],['max_auto_reproductions',3,'Maximum automatic cases'],['max_auto_replay_actions',24,'Total replay actions']])if(!Number.isInteger(values[key])||values[key]<1||values[key]>max)return `${label} must be a whole number from 1 to ${max}.`;
  if(!['desktop','tablet','mobile'].includes(values.viewport_profile))return 'Choose a supported viewport.';
  if(values.provider==='openrouter'&&values.free_only&&values.model.trim()!=='openrouter/free'&&!values.model.trim().endsWith(':free'))return 'Free-only requires openrouter/free or a model ID ending in :free.';
  return '';
}
function updateConfiguration(field,value){
  const draft=configurationDraft();if(draft.saving||!Object.hasOwn(draft.values,field))return false;
  if(field==='provider'){
    draft.models[draft.values.provider]=draft.values.model;
    draft.values.model=draft.models[value]||'';
    if(value!=='openrouter')draft.values.free_only=false;
  }
  draft.values[field]=value;draft.dirty=JSON.stringify(draft.values)!==draft.fingerprint;
  draft.requestId=null;draft.error='';draft.message='';return true;
}
function rebaseConfiguration(discard=false){
  const draft=configurationDraft();if(draft.saving)return;
  if(discard){state.configurationDraft=null;configurationDraft();return;}
  draft.revision=state.settingsRevision;draft.fingerprint=JSON.stringify(configurationValues());draft.dirty=JSON.stringify(draft.values)!==draft.fingerprint;draft.requestId=null;draft.error='';draft.message='Edits kept. Review the values, then save to create a new revision.';
}
function applyConfiguration(snapshot){
  // A polling response started before a save may arrive after it.
  if(Number.isSafeInteger(snapshot.revision)&&snapshot.revision>=state.settingsRevision){state.settings=snapshot.settings;state.settingsRevision=snapshot.revision;}
}
async function saveConfiguration(){
  const draft=configurationDraft();if(draft.saving||!draft.dirty)return;
  draft.error=configurationError(draft.values);
  if(!draft.requestId&&draft.revision!==state.settingsRevision)draft.error='Defaults changed elsewhere. Discard your edits or explicitly keep them on the latest revision before saving.';
  if(draft.error){render();return;}
  draft.requestId??=crypto.randomUUID();draft.saving=true;draft.message='';render();
  const token=state.token,developmentAccess=state.developmentAccess,sameSession=()=>token===state.token&&developmentAccess===state.developmentAccess;
  const body={request_id:draft.requestId,expected_revision:draft.revision,...draft.values,model:draft.values.model.trim()};
  try{
    const saved=await (await api('/v1/exploration-settings',body)).json();if(!sameSession()||state.configurationDraft!==draft)return;
    applyConfiguration(saved);draft.saving=false;draft.dirty=false;state.configurationDraft=null;
    const clean=configurationDraft();clean.message=`Saved revision ${saved.revision}. These defaults apply to new explorations.`;
    toast(clean.message);
    // Read the latest state after an idempotent retry that returned an older revision.
    try{const latest=await get('/v1/exploration-settings');if(sameSession())applyConfiguration(latest);}catch{}
  }catch(error){
    if(!sameSession()||state.configurationDraft!==draft)return;
    draft.error=error.message;
    if(error.code==='revision_conflict'){
      draft.requestId=null;
      try{const latest=await get('/v1/exploration-settings');if(sameSession())applyConfiguration(latest);}catch{}
      draft.error='Defaults changed elsewhere. Your edits are preserved. Choose whether to discard them or keep them on the latest revision.';
    }else if(error.status&&error.status<500){draft.requestId=null;}
  }finally{draft.saving=false;if(sameSession())render();}
}
function configurationView(){
  const draft=configurationDraft(),v=draft.values,conflict=draft.dirty&&draft.revision!==state.settingsRevision,invalid=configurationError(v);
  const field=(key,label,type='text',min='',max='')=>`<label for="configuration-${key}"><span>${label}</span><input id="configuration-${key}" data-configuration-field="${key}" type="${type}" value="${esc(v[key]??'')}" ${type==='number'?`min="${min}" max="${max}" step="1"`:'maxlength="200" autocomplete="off" spellcheck="false"'} required></label>`;
  return `<section class="panel settings-panel"><div class="panel-header"><div><h2>Exploration defaults</h2><p class="small muted">Saved revision ${esc(state.settingsRevision)} · applies to new explorations</p></div>${draft.dirty?'<span class="pill dirty-indicator">Unsaved changes</span>':''}</div><p class="configuration-note small muted">Save the model, action limits and viewport for future jobs. Queued and running jobs keep their original settings. Each URL launch can override its viewport and automatic checks. Saving does not call a model or test a connection.</p><form id="exploration-configuration-form" class="configuration-form"><fieldset ${draft.saving?'disabled':''}><legend class="sr-only">Default exploration settings</legend><div class="configuration-grid"><label for="configuration-provider"><span>Model provider</span><select id="configuration-provider" data-configuration-field="provider">${['openrouter','openai','anthropic'].map(p=>`<option value="${p}" ${v.provider===p?'selected':''}>${providerName(p)}</option>`).join('')}</select></label>${field('model','Model ID')}${field('max_actions','Maximum exploration actions','number',1,12)}<label for="configuration-viewport_profile"><span>Default viewport</span><select id="configuration-viewport_profile" data-configuration-field="viewport_profile">${['desktop','tablet','mobile'].map(p=>`<option value="${p}" ${v.viewport_profile===p?'selected':''}>${p[0].toUpperCase()+p.slice(1)}</option>`).join('')}</select></label>${field('max_auto_reproductions','Maximum automatic cases','number',1,3)}${field('max_auto_replay_actions','Total additional replay actions','number',1,24)}</div><label class="configuration-toggle"><input id="configuration-free_only" data-configuration-field="free_only" type="checkbox" ${v.free_only?'checked':''} ${v.provider!=='openrouter'?'disabled':''}><span>Restrict OpenRouter to free model IDs</span></label><p class="small muted">Use openrouter/free or a model ending in :free. Provider availability and rate limits still apply. Direct OpenAI and Anthropic calls use their own API billing.</p><label class="configuration-toggle"><input id="configuration-auto_reproduce" data-configuration-field="auto_reproduce" type="checkbox" ${v.auto_reproduce?'checked':''}><span>Automatically recheck suspected bugs by default</span></label><p class="small muted">Fresh-browser checks use additional model calls. Findings still require human review. Origins and credentials remain in the private server configuration below.</p></fieldset>${conflict?`<div class="settings-feedback notice" role="status">Saved defaults are now revision ${esc(state.settingsRevision)}. Your edits still use revision ${esc(draft.revision)}. ${draft.requestId?'A previous save may have completed. Retry save to check its original receipt, or discard your edits.':'Review the current values below before keeping your edits.'}</div>`:''}${draft.error?`<p class="settings-feedback notice error" role="alert">${esc(draft.error)}</p>`:''}${draft.message?`<p class="settings-feedback" role="status">${esc(draft.message)}</p>`:''}${draft.dirty&&invalid?`<p class="small muted">${esc(invalid)}</p>`:''}<div class="configuration-actions"><button type="submit" class="button primary" ${draft.saving||!draft.dirty||conflict&&!draft.requestId||invalid?'disabled':''}>${draft.saving?'Saving…':draft.requestId?'Retry save':'Save defaults'}</button><button type="button" class="button" data-action="discard-configuration" ${!draft.dirty||draft.saving?'disabled':''}>Discard edits</button>${conflict?`<button type="button" class="button" data-action="rebase-configuration" ${draft.saving?'disabled':''}>Keep my edits on revision ${esc(state.settingsRevision)}</button>`:''}</div></form></section>`;
}
function connections(){return configurationView()+connectionStatus();}
function connectionStatus(){
  const settings=state.settings||{},providers=state.providers.providers||[];
  return `<p class="view-description">Read-only local configuration. A configured key is not proof of a successful live provider request; credentials are never shown here.</p><div class="connections">${providers.map(p=>`<article class="connection"><div class="provider-logo">${esc({openai:'O',anthropic:'A',openrouter:'OR'}[p.provider]||'?')}</div><h2>${esc(providerName(p.provider))}</h2><span class="pill ${p.configured?'green':''}">${p.configured?'Configured':'Not configured'}</span><p>${p.authentication==='test_fixture'?'Simulated responses for development tests. No live provider connection is verified.':'API key authentication. Keys stay on the server.'}</p>${settings.provider===p.provider?'<span class="pill">Selected for exploration</span>':''}</article>`).join('')||empty('No provider status available','Refresh the workspace to load the local gateway configuration.','bolt')}</div><div class="ops-grid"><section class="panel settings-panel"><h2>Exploration configuration</h2>${kv('Selected provider',providerName(settings.provider))}${kv('Selected model',settings.model||'Not configured')}${kv('Maximum actions',settings.maxActions??'Not reported')}${kv('Default viewport',settings.viewportProfile||'Not reported')}${kv('Provider execution mode',state.providers.test_mode===true?'Simulated':state.providers.test_mode===false?'Live':'Not reported')}${kv('OpenRouter free-only restriction',settings.provider!=='openrouter'?'Not applicable to direct provider billing':settings.freeOnly===true?'Enabled':settings.freeOnly===false?'Disabled':'Not reported')}${kv('Authentication for model subscriptions','Not implemented')}<p class="small muted">Change provider credentials and controlled app origins in the private .env file, then run just dev to apply them. Model defaults can be saved above without a restart. Subscription allowance cannot be inferred from the token ledger.</p></section><section class="panel settings-panel"><h2>Scope & automatic checks</h2>${kv('Allowed app origins',(settings.allowedOrigins||[]).join(', ')||'None reported')}${kv('Automatic reproduction default',settings.autoReproduce===true?'Enabled':settings.autoReproduce===false?'Disabled':'Not reported')}${kv('Maximum automatic cases',settings.maxAutoReproductions??'Not reported')}${kv('Additional replay actions in total',settings.maxAutoReplayActions??'Not reported')}<p class="small muted">Only configured controlled-app origins are eligible. Each URL launch can choose whether automatic checks are enabled. Automatic replay outcomes still require human review.</p></section></div>${savedSessions()}<section class="panel settings-panel"><h2>Local browser workers</h2><p class="small muted">Availability requires an online heartbeat within 20 seconds. One local worker executes browser jobs at a time.</p>${state.workers.map(w=>kv(short(w.worker_id),`${w.available?'Online':'Offline'} · last heartbeat ${date(w.heartbeat_at)}`)).join('')||'<p class="small muted">No browser worker has registered. Run just dev to start the local services.</p>'}</section>`;
}
function reportTools(){return reportToolsPromise??=import('/assets/report-bundle.js').catch(error=>{reportToolsPromise=null;throw error;});}
function exportBytes(value){return value==null?'Unknown':`${(value/1024/1024).toFixed(2)} MB`;}
function exportView(exportState){
  const r=exportState.snapshot,run=r.run,p=exportState.progress,result=exportState.result;
  return `<div class="report-export"><p class="eyebrow">Run ${esc(short(run.run_id))} · ${esc(run.lifecycle)}</p><p class="small muted">Frozen at ${esc(date(exportState.generatedAt))}. This download contains the selected run’s recorded application data; review it before sharing.</p>${run.lifecycle==='active'?'<div class="notice">This run is still active. The report is a partial snapshot, and later actions or uploads are not included.</div>':''}<div class="export-formats"><section><h3>Readable report</h3><p>Steps, expected and observed results, human review history, coverage limits and usage. Evidence is referenced by ID.</p>${button('download-report','Download Markdown','download',`data-format="markdown" ${exportState.busy?'disabled':''}`)}</section><section><h3>Evidence bundle</h3><p>Markdown, the run JSON, original PNGs, masks, recorded JSON artifacts and a SHA-256 manifest. Missing or unverified files are listed as gaps.</p>${button('download-report','Download evidence ZIP','download',`data-format="zip" ${exportState.busy?'disabled':''}`)}</section><section><h3>Recorded data</h3><p>The complete selected run snapshot in the existing JSON format.</p>${button('download-report','Download JSON','download',`data-format="json" ${exportState.busy?'disabled':''}`)}</section></div><p class="small muted">Only this run’s evidence is included. Related reproductions retain their own run IDs and must be exported separately. Provider payloads and private sign-in sessions are not added. This report does not approve data for training.</p><p class="small muted">ZIP limits: 256 evidence files, 8 MB per file and 64 MB per archive. Larger exports can use the JSON report and individual evidence downloads.</p>${exportState.busy?`<div class="export-progress" role="status"><strong>${exportState.format==='zip'?'Verifying recorded evidence…':'Preparing report…'}</strong>${p?`<progress max="${Math.max(1,p.total)}" value="${p.processed}" aria-label="Evidence files processed"></progress><p>${esc(p.processed)} of ${esc(p.total)} processed · ${esc(p.included)} verified · ${esc(p.gaps)} gaps · ${exportBytes(p.verifiedBytes)}</p>`:''}${button('cancel-report-export','Cancel download','close')}</div>`:''}${exportState.error?`<div class="notice error" role="alert">${esc(exportState.error)}</div>`:''}${result?`<div class="export-result notice" role="status"><span>${result.format==='zip'?`Evidence ZIP downloaded: ${esc(result.included)} verified files${result.gaps?` and ${esc(result.gaps)} evidence gaps`:''}. ${result.gaps?'Inspect manifest.json for the missing or unverified files.':'The manifest records verified file hashes.'}`:`${result.format==='markdown'?'Markdown':'JSON'} report downloaded.`}</span></div><p class="small mono">Export ${esc(exportState.exportId)}</p>`:''}</div>`;
}
function openReportExport(){
  if(!state.report?.run)return;
  closeReportExport();
  state.drawer={title:'Export run report',export:{snapshot:JSON.parse(JSON.stringify(state.report)),exportId:crypto.randomUUID(),generatedAt:new Date().toISOString(),busy:false,progress:null,error:'',result:null,controller:null}};render();
}
function closeReportExport(){
  if(state.drawer?.export?.controller)state.drawer.export.controller.abort(new DOMException('Export cancelled.','AbortError'));
}
function downloadBlob(blob,filename){
  const url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download=filename;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),60000);
}
async function downloadReport(format){
  const d=state.drawer?.export;if(!d||d.busy||!['json','markdown','zip'].includes(format))return;
  const token=state.token,developmentAccess=state.developmentAccess,current=()=>state.connected&&state.drawer?.export===d&&state.token===token&&state.developmentAccess===developmentAccess;
  d.busy=true;d.format=format;d.error='';d.progress=null;d.result=null;d.controller=new AbortController();render();
  try{
    const tools=await reportTools();if(!current()||d.controller.signal.aborted)return;
    const opts={exportId:d.exportId,generatedAt:d.generatedAt};let blob,filename,result;
    if(format==='zip'){
      result=await tools.buildEvidenceBundle(d.snapshot,{...opts,signal:d.controller.signal,fetchFile:async(path,{signal})=>{
        if(!current()){const error=new Error('Workspace disconnected.');error.code='workspace_disconnected';throw error;}
        return api(path,undefined,{},18000,signal);
      },onProgress:progress=>{if(current()){d.progress=progress;render();}}});blob=result.blob;filename=result.filename;
    }else{
      const bytes=format==='json'?tools.reportJson(d.snapshot):tools.reportMarkdown(d.snapshot,opts);
      blob=new Blob([bytes],{type:format==='json'?'application/json':'text/markdown;charset=utf-8'});filename=`scout-run-${d.snapshot.run.run_id}.${format==='json'?'json':'md'}`;
    }
    if(!current()||d.controller.signal.aborted)return;
    downloadBlob(blob,filename);
    d.result={format,included:result?.manifest.evidence.filter(e=>e.status==='included').length||0,gaps:result?.manifest.evidence.filter(e=>e.status!=='included').length||0};
  }catch(error){if(current())d.error=d.controller.signal.aborted?'Download cancelled. The recorded evidence is unchanged.':error.message||'Report export failed. Try again.';}
  finally{d.busy=false;if(current())render();}
}
function drawer(){
  const d=state.drawer;if(!d)return '';
  let body=d.loading?'<div class="loading">Loading request…</div>':d.error?`<div class="notice error">${esc(d.error)}</div>`:d.raw?json(d.raw):'';
  if(d.export)body=exportView(d.export);
  if(d.image)body=`<p class="small muted">${esc(d.image.alt)}. The original PNG remains unchanged.</p><div class="row evidence-tools">${button('image-scale',d.image.fit?'View actual pixels':'Fit to panel','image')}<span class="pill">${d.image.fit?'Fit to panel':'Actual pixels · 100%'}</span></div><div class="evidence-canvas ${d.image.fit?'fit-resolution':'native-resolution'}" data-image-path="${esc(d.image.path)}" data-alt="${esc(d.image.alt)}" tabindex="0" role="region" aria-label="Scrollable screenshot"><span class="loading">Loading recorded image…</span></div>`;
  if(d.model){const m=d.model;body=`<span class="eyebrow">Request ${short(m.request.request_id)}</span><h2>${esc(m.request.model)}</h2><p class="small muted">${esc(providerName(m.request.provider))} · ${esc(m.request.execution_mode)} · ${m.calls.length} attempts</p><h3>Input & frozen context</h3>${json(m.request.spec)}${m.calls.map(call=>`<h3>Attempt ${call.attempt} ${pill(call.state)}</h3><div class="stats">${stat('Input tokens',number(call.input_tokens),'Provider-reported','bolt')}${stat('Output tokens',number(call.output_tokens),call.usage_status,'bolt')}</div>${kv('Duration',call.elapsed_ms==null?'Unknown':`${call.elapsed_ms} ms`)}${kv('Provider cost',call.cost_usd==null?'Unknown':`$${call.cost_usd}`)}${kv('Error',call.error||'None')}<h3>Response</h3><pre class="json">${esc(call.output_text||'No complete response was recorded.')}</pre>`).join('')}<h3>Stored request / response payloads</h3>${m.payloads.map(p=>`<div class="key-value"><span>${esc(p.kind)} · ${number(p.byte_length)} bytes</span><span>${p.uploaded_at?'Saved in bucket':'Awaiting export'}</span></div><p class="mono muted">${esc(p.object_key)}</p>`).join('')}<h3>Provider event history</h3>${json(m.events)}`;}
  return `<div class="drawer-backdrop" data-action="close-drawer"><section class="drawer ${d.image?'evidence-drawer':''}" role="dialog" aria-modal="true" aria-labelledby="drawer-title"><div class="drawer-head"><h2 id="drawer-title">${esc(d.title||'Execution details')}</h2><button class="button icon" data-action="close-drawer" aria-label="Close details">${icon('close')}</button></div><div class="drawer-body">${body}</div></section></div>`;
}
function render(){
  if(!state.connected){login();return;}
  if(composing)return;
  const focused=document.activeElement,focusId=focused?.id,selection=[focused?.selectionStart,focused?.selectionEnd,focused?.selectionDirection];
  const focusKey=focused?.dataset?.action?{...focused.dataset}:null,identity=[state.view,state.runId,state.opsTab,state.tab].join(':');
  const preserved=identity===renderIdentity;
  const details=preserved?Array.from(root.querySelectorAll('details[data-disclosure]')).map(n=>[n.dataset.disclosure,n.open]):[];
  const scroll=preserved?Array.from(root.querySelectorAll('.action-list,.event-list,.table-wrap,.drawer,.discovery-tree')).map(n=>[n.scrollTop,n.scrollLeft]):[];
  const hadDrawer=!!root.querySelector?.('.drawer');
  if(state.drawer&&!hadDrawer)drawerOpener={id:focusId,key:focusKey};
  root.innerHTML=shell(state.view==='operations'?operations():state.runId?runView():home());
  renderIdentity=identity;
  for(const node of root.querySelectorAll('details[data-disclosure]')){const saved=details.find(([key])=>key===node.dataset.disclosure);if(saved)node.open=saved[1];}
  Array.from(root.querySelectorAll('.action-list,.event-list,.table-wrap,.drawer,.discovery-tree')).forEach((node,i)=>{if(scroll[i]){node.scrollTop=scroll[i][0];node.scrollLeft=scroll[i][1];}});
  const input=focusId?document.getElementById(focusId):focusKey?Array.from(root.querySelectorAll('[data-action]')).find(n=>Object.keys(focusKey).every(key=>n.dataset[key]===focusKey[key])):null;
  if(input){input.focus({preventScroll:true});if(typeof selection[0]==='number'&&input.setSelectionRange)try{input.setSelectionRange(...selection);}catch{}}
  if(state.drawer&&!hadDrawer)root.querySelector?.('.drawer button')?.focus();
  if(!state.drawer&&hadDrawer){
    const opener=drawerOpener?.id?document.getElementById(drawerOpener.id):drawerOpener?.key?Array.from(root.querySelectorAll('[data-action]')).find(n=>Object.keys(drawerOpener.key).every(key=>n.dataset[key]===drawerOpener.key[key])):null;
    (opener||input||document.getElementById?.('main-content'))?.focus({preventScroll:true});drawerOpener=null;
  }
  void loadImages();
}
async function refresh(){
  if(refreshing||(!state.token&&!state.developmentAccess))return;refreshing=true;
  const token=state.token,developmentAccess=state.developmentAccess;
  try{
    const [runs,jobs,providers,operations,usage,access]=await Promise.all(['/v1/runs','/v1/browser-jobs','/v1/model-providers','/v1/operations','/v1/usage','/v1/browser-access'].map(get));
    if((token!==state.token||developmentAccess!==state.developmentAccess))return;
    state.runs=runs.runs;state.jobs=jobs.jobs;state.workers=jobs.workers;applyConfiguration({settings:jobs.settings,revision:jobs.settings_revision??jobs.settings?.settingsRevision??0});state.providers=providers;state.operations=operations;state.usage=usage;state.access=access;
    if(privateLogin&&!access.requests.some(a=>a.access_id===privateLogin.id&&['waiting','active'].includes(a.status)))await closePrivateLogin(false);
    if(state.runId){const id=state.runId;const report=await get('/v1/runs/'+id);if((token!==state.token||developmentAccess!==state.developmentAccess))return;if(id===state.runId){report.steering=mergeSteering(report.steering,state.report?.steering);state.report=report;if(!report.actions.some(a=>a.action_id===state.actionId))state.actionId=(report.actions.find(a=>a.assessment?.verdict==='suspect')||report.actions.at(-1))?.action_id;}}
    state.error='';state.connected=true;state.lastUpdatedAt=new Date().toISOString();render();followSubmittedJob();
  }catch(error){if((token===state.token&&developmentAccess===state.developmentAccess)){state.error=error.message;render();}}finally{refreshing=false;}
}
async function route(){
  const parts=location.hash.replace(/^#\/?/,'').split('/');
  state.view=parts[0]==='operations'?'operations':'workspace';
  const id=/^[\da-f-]{36}$/.test(parts[1]||'')?parts[1]:null;
  if(state.trackedJobId&&(state.view!=='workspace'||id))clearTrackedJob();
  if(id!==state.runId){state.runId=id;state.report=null;state.actionId=null;state.tab='actions';state.image='after';state.findingFilter='needs_review';state.expanded.clear();clearImages();}
  const action=/^[\da-f-]{36}$/.test(parts[2]||'')?parts[2]:null;if(action){state.actionId=action;state.tab='actions';}
  closeReportExport();state.drawer=null;render();await refresh();
  if(state.focusLaunch&&state.view==='workspace'&&!state.runId){state.focusLaunch=false;document.getElementById('target-url')?.focus();}
  if(state.openFindingsRun===state.runId){state.tab='findings';state.findingFilter='needs_review';state.openFindingsRun=null;render();}
}
function navigateAction(direction,id){
  const actions=state.tab==='findings'?filteredFindings():state.report?.actions||[],index=actions.findIndex(a=>a.action_id===state.actionId),target=index>=0?actions[index+direction]:null;
  if(!target||target.action_id!==id)return false;
  state.actionId=id;state.frameId=null;if(state.image!=='compare')state.image='after';render();return true;
}
function followSubmittedJob(){
  if(state.view!=='workspace'||state.runId||!state.trackedJobId)return false;
  const job=state.jobs.find(j=>j.job_id===state.trackedJobId);
  if(!job?.run_id)return false;
  clearTrackedJob();
  location.hash='#/workspace/'+job.run_id;return true;
}
function clearTrackedJob(){state.trackedJobId=null;sessionStorage.removeItem('scout.tracked-job');}
async function submitJob(request){
  if(state.submitting)return;state.submitting=true;state.error='';render();
  const token=state.token,developmentAccess=state.developmentAccess,originView=state.view,originRun=state.runId;
  let saved;try{saved=JSON.parse(sessionStorage.getItem('scout.pending-job')||'null');}catch{}
  const spec=saved&&JSON.stringify(saved.request)===JSON.stringify(request)?saved:{request,job_id:crypto.randomUUID()};
  sessionStorage.setItem('scout.pending-job',JSON.stringify(spec));
  try{
    const response=await (await api('/v1/browser-jobs',{job_id:spec.job_id,...request})).json();if((token!==state.token||developmentAccess!==state.developmentAccess))return;
    sessionStorage.removeItem('scout.pending-job');toast(response.reused?'Showing the existing job.':'Queued. Your test will open here when the browser starts.');
    if(state.view===originView&&state.runId===originRun){
      if(originView==='workspace'){
        state.trackedJobId=response.job.job_id;sessionStorage.setItem('scout.tracked-job',state.trackedJobId);
        state.runId=null;state.report=null;state.actionId=null;location.hash='#/workspace';
      }else{state.opsTab='jobs';}
    }
    await refresh();
  }catch(error){if((token===state.token&&developmentAccess===state.developmentAccess))state.error=error.message;}
  finally{state.submitting=false;if((token===state.token&&developmentAccess===state.developmentAccess))render();}
}
root.addEventListener('submit',async e=>{
  e.preventDefault();
  if(e.target.id==='login-form'){
    state.token=new FormData(e.target).get('token').trim();state.error='';
    try{await get('/readyz');sessionStorage.setItem('scout.workspace-token',state.token);state.connected=true;await route();}catch(error){state.error=error.message;login();}
  }else if(e.target.id==='steering-form'){await submitSteering(e.target.dataset.runId);}else if(e.target.id==='exploration-configuration-form'){await saveConfiguration();}else if(e.target.id==='finding-review-form'){await submitReview(e.target.dataset.sourceAction);}else if(e.target.id==='run-form'){await submitJob(explorationRequest(new FormData(e.target)));}
});
root.addEventListener('compositionstart',()=>{composing=true;});
root.addEventListener('compositionend',e=>{composing=false;captureInput(e.target);setTimeout(render,0);});
function captureInput(target){
  if(target.id==='steering-focus')return updateSteeringFocus(target.value);
  if(target.dataset.configurationField){const field=target.dataset.configurationField,value=target.type==='checkbox'?target.checked:target.type==='number'?(target.value===''?null:Number(target.value)):target.value;return updateConfiguration(field,value);}
  if(target.dataset.reviewField)updateReviewDraft(target.dataset.reviewAction,target.dataset.reviewField,target.value);
  if(target.id==='target-url')state.url=target.value;
  const field={'run-search':'search','event-search':'eventSearch','job-search':'jobSearch','model-search':'modelSearch'}[target.id];
  if(field)state[field]=target.value;
  return !!field;
}
root.addEventListener('input',e=>{if(captureInput(e.target))render();});
root.addEventListener('change',e=>{if(e.target.id==='auto-reproduce'){state.autoReproduce=e.target.checked;sessionStorage.setItem('scout.auto-reproduce',String(state.autoReproduce));render();}if(e.target.dataset.reviewField){updateReviewDraft(e.target.dataset.reviewAction,e.target.dataset.reviewField,e.target.value);if(e.target.dataset.reviewField==='disposition')render();}if(e.target.id==='auth-mode'){state.authMode=e.target.value;if(state.authMode==='public')state.sessionId='';render();}if(e.target.id==='app-session')state.sessionId=e.target.value;if(e.target.id==='target-url'){state.sessionId='';render();}if(e.target.id==='viewport-profile')state.viewportProfile=e.target.value;if(e.target.id==='ops-run')location.hash='#/operations'+(e.target.value?'/'+e.target.value:'');});
root.addEventListener('change',e=>{
  if(e.target.dataset.configurationField){if(captureInput(e.target))render();return;}
  const field={'run-mode':'runMode','job-filter':'jobFilter','job-mode':'jobMode','model-provider':'modelProvider','model-status':'modelStatus','model-purpose':'modelPurpose'}[e.target.id];
  if(field){state[field]=e.target.value;render();}
});
root.addEventListener('toggle',e=>{if(e.target.dataset.event){if(e.target.open)state.expanded.add(e.target.dataset.event);else state.expanded.delete(e.target.dataset.event);}},true);
root.addEventListener('click',async e=>{
  if(e.target.closest('a[href^="#/"]')&&state.trackedJobId)clearTrackedJob();
  const el=e.target.closest('[data-action]');if(!el)return;
  const action=el.dataset.action;
  if(action==='close-drawer'&&e.target.closest('.drawer')&&!e.target.closest('button[data-action="close-drawer"]'))return;
  if(el.tagName==='A')e.preventDefault();
  if(action==='focus-launch'){state.focusLaunch=true;if(state.view==='workspace'&&!state.runId){state.focusLaunch=false;document.getElementById('target-url')?.focus();}else location.hash='#/workspace';}
  if(action==='open-findings'){state.openFindingsRun=el.dataset.id;if(state.runId===el.dataset.id){state.tab='findings';state.findingFilter='needs_review';state.openFindingsRun=null;render();}else location.hash='#/workspace/'+el.dataset.id;}
  if(action==='run-filter'){state.runFilter=el.dataset.value;render();}
  if(action==='dismiss-tracked-job'){clearTrackedJob();render();}
  if(action==='open-queue'){state.opsTab='jobs';location.hash='#/operations';}
  if(action==='cancel-automatic'||action==='retry-automatic')await cancelAutomatic(el.dataset.id);
  if(action==='cancel-run'||action==='cancel-job')await cancelWork(action==='cancel-run'?'run':'job',el.dataset.id);
  if(action==='app-login')await openPrivateLogin(el.dataset.id);
  if(action==='skip-login'){try{await api('/v1/browser-access/'+el.dataset.id+'/skip',{});await refresh();}catch(error){toast(error.message);}}
  if(action==='cancel-login'){const access=state.access.requests.find(a=>a.access_id===el.dataset.id);if(access)await cancelWork('run',access.run_id);}
  if(action==='revoke-session'){try{await api('/v1/browser-sessions/'+el.dataset.id+'/revoke',{});if(state.sessionId===el.dataset.id)state.sessionId='';await refresh();toast('Saved session removed. A running browser remains signed in until it closes.');}catch(error){toast(error.message);}}
  if(action==='refresh'){await refresh();if(state.connected&&!state.error)toast('Workspace refreshed.');}
  if(action==='logout'){closeReportExport();await closePrivateLogin(true);state.token='';state.developmentAccess=false;state.connected=false;state.report=null;state.drawer=null;state.trackedJobId=null;sessionStorage.removeItem('scout.workspace-token');sessionStorage.removeItem('scout.pending-job');sessionStorage.removeItem('scout.tracked-job');clearImages();state.error='';state.configurationDraft=null;reviewDrafts.clear();steeringDrafts.clear();login();}
  if(action==='discard-configuration'||action==='rebase-configuration'){rebaseConfiguration(action==='discard-configuration');render();}
  if(action==='prev-action'||action==='next-action'){navigateAction(action==='prev-action'?-1:1,el.dataset.id);}
  if(action==='connections'){state.opsTab='connections';if(state.view!=='operations')location.hash='#/operations';else render();}
  if(action==='settling-frame'){state.image='frame';state.frameId=el.dataset.id;render();}
  if(action==='outcome-json'){state.drawer={title:'Action completion and diagnostics',raw:{outcome:selectedAction()?.outcome,frames:(state.report.events||[]).filter(e=>e.action_id===state.actionId&&e.event_type==='action.settling_frame').map(e=>e.payload)}};render();}
  if(action==='tab'){state.tab=el.dataset.value;render();}
  if(action==='finding-filter'){state.findingFilter=el.dataset.value;render();}
  if(action==='ops-tab'){state.opsTab=el.dataset.value;render();}
  if(action==='image'){state.image=el.dataset.value;render();}
  if(action==='zoom-image'&&/^\/v1\/(?:captures\/[\da-f-]{36}\/image|artifacts\/[\da-f-]{36}\/content)$/.test(el.dataset.path||'')){state.drawer={title:'Recorded screenshot',image:{path:el.dataset.path,alt:el.dataset.alt,fit:false}};render();}
  if(action==='image-scale'&&state.drawer?.image){state.drawer.image.fit=!state.drawer.image.fit;render();}
  if(action==='select-action'){state.actionId=el.dataset.id;if(state.tab==='flow'||el.dataset.sourceAction)state.tab='actions';state.image='after';render();}
  if(action==='copy'){try{await navigator.clipboard.writeText(el.dataset.value);toast('ID copied.');}catch{toast('Clipboard unavailable. Select and copy the visible ID.');}}
  if(action==='reset-steering'||action==='rebase-steering'){const d=steeringDraft();if(!d.busy&&!d.command){d.revision=state.report?.steering?.revision||0;d.error='';if(action==='reset-steering'){d.dirty=false;steeringDraft();}render();}}
  if(action==='reproduce')await submitJob({kind:'reproduce',source_action_id:el.dataset.id});
  if(action==='action-json'){state.drawer={title:'Action record',raw:selectedAction()};render();}
  if(action==='job-error'){state.drawer={title:'Browser job',raw:state.jobs.find(j=>j.job_id===el.dataset.id)};render();}
  if(action==='job-lineage'){const job=state.jobs.find(j=>j.job_id===el.dataset.id);state.drawer={title:'Automatic reproduction lineage',raw:{parent_job_id:job?.parent_job_id,source_action_id:job?.automatic_source_action_id,child_job_id:job?.job_id,note:'The parent job is outside the recent queue view. Open the child run to follow its source action.'}};render();}
  if(action==='close-drawer'){closeReportExport();state.drawer=null;render();}
  if(action==='model'){const id=el.dataset.id;state.drawer={title:'Model call details',id,loading:true};render();try{const model=await get('/v1/model-requests/'+id);if(state.drawer?.id===id)state.drawer={title:'Model call details',id,model};}catch(error){if(state.drawer?.id===id)state.drawer={title:'Model call details',id,error:error.message};}render();}
  if(action==='export-run')openReportExport();
  if(action==='download-report')await downloadReport(el.dataset.format);
  if(action==='cancel-report-export'){closeReportExport();if(state.drawer?.export){state.drawer.export.error='Download cancelled. The recorded evidence is unchanged.';render();}}
});
document.addEventListener('click',e=>{if(e.target.closest?.('.skip-link')){e.preventDefault();const main=document.getElementById('main-content');main?.focus();main?.scrollIntoView({block:'start'});}});
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'&&state.drawer){e.preventDefault();closeReportExport();state.drawer=null;render();return;}
  if(e.key==='Tab'&&state.drawer){
    const elements=Array.from(root.querySelectorAll('.drawer button:not(:disabled),.drawer a[href],.drawer input:not(:disabled),.drawer select:not(:disabled),.drawer [tabindex="0"]'));
    const first=elements[0],last=elements.at(-1);
    if(first&&(e.shiftKey&&document.activeElement===first||!e.shiftKey&&document.activeElement===last)){e.preventDefault();(e.shiftKey?last:first).focus();}
  }
  const tab=e.target.closest?.('[role="tab"][data-action="tab"],[role="tab"][data-action="ops-tab"]');
  if(tab&&['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){
    e.preventDefault();const ops=tab.dataset.action==='ops-tab',tabs=ops?['overview','jobs','models','events','connections']:['actions','findings','flow'],field=ops?'opsTab':'tab',i=tabs.indexOf(state[field]);
    state[field]=e.key==='Home'?tabs[0]:e.key==='End'?tabs.at(-1):tabs[(i+(e.key==='ArrowRight'?1:tabs.length-1))%tabs.length];render();document.getElementById((ops?'ops-tab-':'run-tab-')+state[field])?.focus();
  }
});
window.addEventListener('hashchange',route);
setInterval(()=>{if(state.connected&&!document.hidden&&!state.drawer&&!state.submitting)void refresh();},5000);
async function bootstrapSession(){
  try{
    const response=await fetch('/v1/auth-mode',{cache:'no-store',redirect:'error',signal:AbortSignal.timeout(5000)});
    if(!response.ok)throw new Error('Access mode unavailable.');
    state.developmentAccess=(await response.json()).mode==='local_development';
  }catch{state.developmentAccess=false;}
  if(state.developmentAccess){state.token='';sessionStorage.removeItem('scout.workspace-token');}
  if(state.developmentAccess||state.token){state.connected=true;await route();}else login();
}
if(document.readyState==='complete')void bootstrapSession();
else window.addEventListener('DOMContentLoaded',()=>void bootstrapSession(),{once:true});

function authOptions(){
  let origin='';try{origin=new URL(state.url).origin;}catch{}
  const sessions=(state.access.sessions||[]).filter(s=>s.origin===origin&&!s.revoked_at&&new Date(s.expires_at)>new Date()&&s.execution_mode===(state.providers.test_mode?'protocol_fixture':'live'));
  return `<details class="auth-options" data-disclosure="app-access"><summary>App access · ${state.authMode==='public'?'Public pages only':state.authMode==='sign_in'?'Sign in first':'Ask when sign-in is detected'}</summary><div class="auth-options-fields"><label>Sign-in preference<select form="run-form" name="auth_mode" id="auth-mode">${[['auto','Ask when sign-in is detected'],['sign_in','Sign in before exploration'],['public','Public pages only']].map(([value,label])=>`<option value="${value}" ${state.authMode===value?'selected':''}>${label}</option>`).join('')}</select></label><label>Saved app session<select form="run-form" name="session_id" id="app-session" ${state.authMode==='public'?'disabled':''}><option value="">Start without a saved session</option>${sessions.map(s=>`<option value="${s.session_id}" ${state.sessionId===s.session_id?'selected':''}>Saved ${date(s.created_at)} · expires ${date(s.expires_at)}</option>`).join('')}</select></label></div><p class="small muted">You can sign in yourself when Scout asks. Private login activity is excluded from screenshots, model inputs and training evidence. Google and other external identity providers are not supported in this local handoff yet.</p></details>`;
}
function accessBanner(){
  return (state.access.requests||[]).filter(a=>['waiting','active'].includes(a.status)).map(a=>`<section class="notice access-notice" role="status">${icon('info')}<div><strong>${a.status==='active'?'Private sign-in in progress':a.reason==='login_available'?'Sign-in is available':'Sign-in needed to continue'}</strong><p>${esc(a.origin)} · ${a.status==='active'?'The browser is reserved for the person signing in.':'Open the test browser and sign in yourself. Scout will continue from the authenticated app.'}</p><span class="small muted">Request ${short(a.access_id)} · expires ${date(a.expires_at)}</span></div><div class="access-buttons">${a.status==='waiting'?button('app-login','Open private login','globe',`data-id="${a.access_id}"`):''}${a.status==='waiting'&&a.reason==='login_available'?button('skip-login','Explore public pages','arrow',`data-id="${a.access_id}"`):''}${button('cancel-login','Cancel run','close',`data-id="${a.access_id}"`)}</div></section>`).join('');
}
function savedSessions(){
  const sessions=state.access.sessions||[];
  return `<section class="panel settings-panel"><h2>Saved app sessions</h2><p class="small muted">Encrypted on this machine for up to 24 hours. Select a session when starting a run for the same app. Removing it prevents future reuse; an already running browser keeps its current session.</p>${sessions.map(s=>`<div class="key-value"><span>${esc(s.origin)}<small class="table-sub">${s.execution_mode==='protocol_fixture'?'Test session · ':''}${short(s.session_id)} · expires ${date(s.expires_at)}</small></span>${s.revoked_at?'<span class="muted">Removed</span>':new Date(s.expires_at)<=new Date()?'<span class="muted">Expired</span>':button('revoke-session','Remove session','close',`data-id="${s.session_id}"`)}</div>`).join('')||'<p>No saved app sessions.</p>'}</section>`;
}
// This live view is deliberately separate from imageCache and recorded evidence.
let privateLogin=null,privateFrame=null,privateFrameUrl=null,privateTimer=null,privateBusy=false;
async function privateRequest(action,body){
  const login=privateLogin;if(!login)throw new Error('Login window is closed.');
  const response=await api(`/v1/browser-access/${login.id}/${action}`,body,{'X-Scout-Access-Lease':login.lease});
  if(privateLogin!==login)throw new Error('Login window is closed.');return response;
}
function privateStatus(message){const node=document.getElementById('private-status');if(node)node.textContent=message;}
async function privateScreen(){
  clearTimeout(privateTimer);if(!privateLogin||privateBusy)return;
  const login=privateLogin;
  try{
    const response=await privateRequest('screen');const blob=await response.blob();
    if(privateLogin!==login)return;
    const frame=response.headers.get('x-scout-frame-id'),url=URL.createObjectURL(blob),image=document.getElementById('private-screen');
    if(!image){URL.revokeObjectURL(url);return;}
    const previous=privateFrameUrl;privateFrameUrl=url;privateFrame=frame;image.src=url;
    if(previous)URL.revokeObjectURL(previous);
  }catch(error){
    if(['access not found','access closed','lease required'].includes(error.message)){await closePrivateLogin(false);toast('The private login session has ended.');void refresh();return;}
    privateStatus(error.message);
  }
  if(privateLogin===login)privateTimer=setTimeout(privateScreen,1500);
}
async function privateInput(input){
  if(privateBusy||!privateLogin)return;privateBusy=true;clearTimeout(privateTimer);
  try{await privateRequest('input',{input_id:crypto.randomUUID(),...input});privateStatus('Input sent to the test browser.');}
  catch(error){privateStatus(error.message==='stale frame'?'The view changed. Click the field again.':error.message==='not editable'?'Click an input field in the app image first.':error.message);}
  finally{privateBusy=false;if(privateLogin)void privateScreen();}
}
async function openPrivateLogin(id){
  if(privateLogin)return;
  try{
    const runId=state.access.requests.find(a=>a.access_id===id)?.run_id;
    if(!runId)throw new Error('Refresh the workspace to reopen this login.');
    const response=await (await api(`/v1/browser-access/${id}/start`,{client_id:crypto.randomUUID()})).json();
    privateLogin={id,runId,lease:response.lease};
    const box=document.getElementById('private-login');
    box.innerHTML=`<div class="private-backdrop"><section class="private-dialog" role="dialog" aria-modal="true" aria-labelledby="private-title"><div class="drawer-head"><div><h2 id="private-title">Sign in to your test app</h2><p class="small muted">Live private view · not recorded · Scout is paused</p></div><button class="button" data-private="cancel">Cancel run</button></div><div class="private-body"><p>Click a field in the image, then type or paste into the box below. Use Tab and Enter to move through the login form. Complete any verification code yourself.</p><img id="private-screen" alt="Live view of your private test browser" tabindex="0"><div class="private-controls"><button class="button" data-private="key" data-key="Shift+Tab">Previous field</button><button class="button" data-private="key" data-key="Tab">Next field</button><button class="button" data-private="key" data-key="Enter">Enter</button><button class="button" data-private="key" data-key="Backspace">Backspace</button><button class="button" data-private="scroll" data-direction="up">Scroll up</button><button class="button" data-private="scroll" data-direction="down">Scroll down</button></div><form id="private-text-form"><label for="private-text">Type into the selected field</label><div class="private-controls"><input id="private-text" type="password" maxlength="2048" autocomplete="off" placeholder="Text is sent only to this test browser"><button class="button" type="submit">Send text</button></div></form><p id="private-status" role="status">Opening the private browser…</p><label class="private-remember"><input id="private-remember" type="checkbox"> Save this app session on this machine for 24 hours</label><div class="private-controls"><button class="button primary" data-private="complete">I'm signed in · continue testing</button><span class="small muted">Google and external provider login are not supported yet.</span></div></div></section></div>`;
    box.onclick=async e=>{
      if(e.target.id==='private-screen'){
        const image=e.target,r=image.getBoundingClientRect();if(!privateFrame)return;
        await privateInput({type:'click',frame_id:privateFrame,x:(e.clientX-r.left)*image.naturalWidth/r.width,y:(e.clientY-r.top)*image.naturalHeight/r.height});return;
      }
      const button=e.target.closest('[data-private]');if(!button)return;
      if(button.dataset.private==='cancel'){try{await closePrivateLogin(true);await refresh();}catch(error){privateStatus(error.message);if(privateLogin)void privateScreen();}}
      if(button.dataset.private==='key')await privateInput({type:'key',key:button.dataset.key});
      if(button.dataset.private==='scroll')await privateInput({type:'scroll',direction:button.dataset.direction});
      if(button.dataset.private==='complete'&&!privateBusy){
        privateBusy=true;clearTimeout(privateTimer);
        try{await privateRequest('complete',{remember:document.getElementById('private-remember').checked});await closePrivateLogin(false);toast('App access checked. Exploration is continuing.');await refresh();}
        catch(error){privateStatus(error.message==='login not complete'?'Sign-in is not complete. Finish the app login, then try again.':error.message);}
        finally{privateBusy=false;if(privateLogin)void privateScreen();}
      }
    };
    box.onsubmit=async e=>{if(e.target.id!=='private-text-form')return;e.preventDefault();const input=document.getElementById('private-text'),value=input.value;input.value='';if(value)await privateInput({type:'text',value});};
    box.onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();privateStatus('Use Cancel run to close this private session.');}if(e.target.id==='private-screen'&&['Tab','Enter','Backspace','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();void privateInput({type:'key',key:e.shiftKey&&e.key==='Tab'?'Shift+Tab':e.key});}};
    document.getElementById('private-screen').focus();void privateScreen();
  }catch(error){toast(error.message);}
}
async function closePrivateLogin(cancel){
  clearTimeout(privateTimer);
  if(cancel&&privateLogin)await api('/v1/runs/'+privateLogin.runId+'/cancel',{});
  privateLogin=null;privateFrame=null;
  if(privateFrameUrl)URL.revokeObjectURL(privateFrameUrl);privateFrameUrl=null;
  const box=document.getElementById('private-login');if(box){box.replaceChildren();box.onclick=null;box.onsubmit=null;box.onkeydown=null;}
}
