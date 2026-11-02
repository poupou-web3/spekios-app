// Back office rendering, refresh and routing (#/<overview|jobs|models|events|connections>[/<run>]).
import {icon} from '/assets/ui/components.js';
import {date,esc} from '/assets/ui/format.js';
import {themeSwitch} from '/assets/ui/theme.js';
import {get} from './api.js';
import {TABS,root,state} from './state.js';
import {drawer} from './views/drawer.js';
import {operations} from './views/operations.js';
let refreshing = false, renderIdentity = '', drawerOpener = null;
export function login(){
  root.innerHTML=`<main class="login" id="main-content" tabindex="-1"><form id="login-form" class="login-card"><div class="brand"><span class="mark">${icon('scout')}</span>scout<small>BACK OFFICE</small></div><h1>Operations console</h1><p>Browser workers, queued jobs, model calls and evidence delivery, for the team operating Scout.</p><label for="token">Operator access token</label><input id="token" name="token" type="password" required minlength="32" autocomplete="off" placeholder="Enter the operator token">${state.error?`<div class="login-error" role="alert">${esc(state.error)}</div>`:''}<button class="button primary" type="submit">Open back office ${icon('arrow')}</button><div class="small">Use SCOUT_API_TOKEN from the service configuration. The token stays in this browser tab; it is never added to the URL.</div></form></main>`;
}
export function shell(content){
  const online=state.workers.some(w=>w.available);
  return `<div class="ops-app"><header class="ops-header"><a class="brand" href="#/overview" aria-label="Scout back office"><span class="mark">${icon('scout')}</span>scout<small>BACK OFFICE</small></a><span class="ops-status"><i class="dot ${online?'green':'amber'}"></i>${online?'Browser worker online':'No worker heartbeat'}</span><div class="topbar-right"><span>${state.error?'Refresh interrupted':state.lastUpdatedAt?'Updated '+esc(date(state.lastUpdatedAt)):'Waiting for a snapshot'}</span><button class="button icon" data-action="refresh" aria-label="Refresh back office">${icon('refresh')}</button>${themeSwitch()}${state.developmentAccess?'<span class="pill dev-access-badge">DEV</span>':`<button class="button icon" data-action="logout" aria-label="Sign out of the back office">${icon('logout')}</button>`}</div></header><main class="content" id="main-content" tabindex="-1">${state.error?`<div class="notice error" role="alert">${icon('info')}<span>${esc(state.error)}. Showing the last available data.</span></div>`:''}${content}</main>${drawer()}</div>`;
}
export function render(){
  if(!state.connected){login();return;}
  if(state.composing)return;
  const focused=document.activeElement,focusId=focused?.id,selection=[focused?.selectionStart,focused?.selectionEnd,focused?.selectionDirection];
  const focusKey=focused?.dataset?.action?{...focused.dataset}:null,identity=[state.opsTab,state.runId].join(':');
  const preserved=identity===renderIdentity;
  const details=preserved?Array.from(root.querySelectorAll('details[data-disclosure]')).map(n=>[n.dataset.disclosure,n.open]):[];
  const scroll=preserved?Array.from(root.querySelectorAll('.event-list,.table-wrap,.drawer')).map(n=>[n.scrollTop,n.scrollLeft]):[];
  const hadDrawer=!!root.querySelector?.('.drawer');
  if(state.drawer&&!hadDrawer)drawerOpener={id:focusId,key:focusKey};
  root.innerHTML=shell(operations());
  renderIdentity=identity;
  for(const node of root.querySelectorAll('details[data-disclosure]')){const saved=details.find(([key])=>key===node.dataset.disclosure);if(saved)node.open=saved[1];}
  Array.from(root.querySelectorAll('.event-list,.table-wrap,.drawer')).forEach((node,i)=>{if(scroll[i]){node.scrollTop=scroll[i][0];node.scrollLeft=scroll[i][1];}});
  const input=focusId?document.getElementById(focusId):focusKey?Array.from(root.querySelectorAll('[data-action]')).find(n=>Object.keys(focusKey).every(key=>n.dataset[key]===focusKey[key])):null;
  if(input){input.focus({preventScroll:true});if(typeof selection[0]==='number'&&input.setSelectionRange)try{input.setSelectionRange(...selection);}catch{}}
  if(state.drawer&&!hadDrawer)root.querySelector?.('.drawer button')?.focus();
  if(!state.drawer&&hadDrawer){
    const opener=drawerOpener?.id?document.getElementById(drawerOpener.id):drawerOpener?.key?Array.from(root.querySelectorAll('[data-action]')).find(n=>Object.keys(drawerOpener.key).every(key=>n.dataset[key]===drawerOpener.key[key])):null;
    (opener||input||document.getElementById?.('main-content'))?.focus({preventScroll:true});drawerOpener=null;
  }
}
export async function refresh(){
  if(document.activeElement?.closest?.('#demo-settings-form')||document.getElementById?.('demo-api-key')?.value)return;
  if(refreshing||(!state.token&&!state.developmentAccess))return;refreshing=true;
  const token=state.token,developmentAccess=state.developmentAccess;
  try{
    const [runs,jobs,providers,operations,usage]=await Promise.all(['/v1/runs','/v1/browser-jobs','/v1/model-providers','/v1/operations','/v1/usage'].map(get));
    if(token!==state.token||developmentAccess!==state.developmentAccess)return;
    state.runs=runs.runs;state.jobs=jobs.jobs;state.workers=jobs.workers;state.settings=jobs.settings||{};state.providers=providers;state.operations=operations;state.usage=usage;
    if(state.opsTab==='credits')state.demo=await get('/v1/admin/demo');
    if(state.runId){const id=state.runId;const headers=state.reportEtag&&state.report?.run?.run_id===id?{'If-None-Match':state.reportEtag}:{};const report=await get('/v1/runs/'+id, headers);if(token!==state.token||developmentAccess!==state.developmentAccess)return;if(report&&id===state.runId){if(typeof report._etag==='string'){state.reportEtag=report._etag;delete report._etag;}state.report=report;}}
    state.error='';state.connected=true;state.lastUpdatedAt=new Date().toISOString();render();
  }catch(error){if(token===state.token&&developmentAccess===state.developmentAccess){state.error=error.message;render();}}finally{refreshing=false;}
}
export async function route(){
  const [tab,id]=location.hash.replace(/^#\/?/,'').split('/');
  state.opsTab=TABS.includes(tab)?tab:'overview';
  const runId=/^[\da-f-]{36}$/.test(id||'')?id:null;
  if(runId!==state.runId){state.runId=runId;state.report=null;state.reportEtag='';state.expanded.clear();}
  state.drawer=null;render();await refresh();
}
// Tabs update the address without a reload so a refresh or shared link keeps the view.
export function tabHash(tab=state.opsTab){return '#/'+tab+(state.runId?'/'+state.runId:'');}
export function selectTab(tab){state.opsTab=TABS.includes(tab)?tab:'overview';globalThis.history?.replaceState?.(null,'',tabHash());render();}
export async function bootstrapSession(){
  try{
    const response=await fetch('/v1/auth-mode',{cache:'no-store',redirect:'error',signal:AbortSignal.timeout(5000)});
    if(!response.ok)throw new Error('Access mode unavailable.');
    state.developmentAccess=(await response.json()).mode==='local_development';
  }catch{state.developmentAccess=false;}
  if(state.developmentAccess){state.token='';sessionStorage.removeItem('scout.backoffice-token');}
  if(state.developmentAccess||state.token){state.connected=true;await route();}else login();
}
