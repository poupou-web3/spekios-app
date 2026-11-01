// Rendering, data refresh and hash routing for the workspace (#/workspace, #/workspace/<run>[/<action>], #/settings).
import {get} from './api.js';
import {clearImages,loadImages} from './images.js';
import {clearTrackedJob,followSubmittedJob} from './jobs.js';
import {closePrivateLogin,privateLogin} from './private-login.js';
import {login,shell} from './shell.js';
import {root,state} from './state.js';
import {closeReportExport} from './views/export.js';
import {home} from './views/home.js';
import {runView} from './views/run.js';
import {applyConfiguration,settingsView} from './views/settings.js';
import {mergeSteering} from './views/steering.js';
let refreshing = false, renderIdentity = '', drawerOpener = null, rendering = false, renderAgain = false;
export function render(){
  if(!state.connected){login();return;}
  if(state.composing)return;
  // Replacing a focused field makes Chrome fire its pending change event inside the replacement.
  // A handler that renders from there would replace the same nodes again, so it waits for this pass.
  if(rendering){renderAgain=true;return;}
  const focused=document.activeElement,focusId=focused?.id,selection=[focused?.selectionStart,focused?.selectionEnd,focused?.selectionDirection];
  const focusKey=focused?.dataset?.action?{...focused.dataset}:null,identity=[state.view,state.runId,state.tab].join(':');
  const preserved=identity===renderIdentity;
  const details=preserved?Array.from(root.querySelectorAll('details[data-disclosure]')).map(n=>[n.dataset.disclosure,n.open]):[];
  const scroll=preserved?Array.from(root.querySelectorAll('.action-list,.event-list,.table-wrap,.drawer,.discovery-tree')).map(n=>[n.scrollTop,n.scrollLeft]):[];
  const hadDrawer=!!root.querySelector?.('.drawer');
  if(state.drawer&&!hadDrawer)drawerOpener={id:focusId,key:focusKey};
  rendering=true;
  try{root.innerHTML=shell(state.view==='settings'?settingsView():state.runId?runView():home());}finally{rendering=false;}
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
  if(renderAgain){renderAgain=false;render();}
}
export async function refresh(){
  if(refreshing||(!state.token&&!state.developmentAccess&&!state.browserAuth))return;refreshing=true;
  const token=state.token,developmentAccess=state.developmentAccess,browserAuth=state.browserAuth;
  try{
    const [runs,jobs,providers,access]=await Promise.all(['/v1/runs','/v1/browser-jobs','/v1/model-providers','/v1/browser-access'].map(get));
    if((token!==state.token||developmentAccess!==state.developmentAccess||browserAuth!==state.browserAuth))return;
    // Memory is shown only in Settings; other views do not poll it.
    if(state.view==='settings'){try{const memory=await get('/v1/app-memory');if(token===state.token&&developmentAccess===state.developmentAccess&&browserAuth===state.browserAuth){state.memory=memory;state.memoryError='';}}catch(error){if(token===state.token&&developmentAccess===state.developmentAccess&&browserAuth===state.browserAuth)state.memoryError=error.message;}}
    state.runs=runs.runs;state.jobs=jobs.jobs;state.workers=jobs.workers;applyConfiguration({settings:jobs.settings,revision:jobs.settings_revision??jobs.settings?.settingsRevision??0});state.providers=providers;state.access=access;
    if(privateLogin&&!access.requests.some(a=>a.access_id===privateLogin.id&&['waiting','active'].includes(a.status)))await closePrivateLogin(false);
    if(state.runId){const id=state.runId;const headers=state.reportEtag&&state.report?.run?.run_id===id?{'If-None-Match':state.reportEtag}:{};const report=await get('/v1/runs/'+id, headers);if((token!==state.token||developmentAccess!==state.developmentAccess||browserAuth!==state.browserAuth))return;if(report&&id===state.runId){if(typeof report._etag==='string'){state.reportEtag=report._etag;delete report._etag;}report.steering=mergeSteering(report.steering,state.report?.steering);state.report=report;if(!report.actions.some(a=>a.action_id===state.actionId))state.actionId=(report.actions.find(a=>a.assessment?.verdict==='suspect')||report.actions.at(-1))?.action_id;}}
    state.error='';state.connected=true;state.lastUpdatedAt=new Date().toISOString();render();followSubmittedJob();
  }catch(error){if((token===state.token&&developmentAccess===state.developmentAccess&&browserAuth===state.browserAuth)){state.error=error.message;render();}}finally{refreshing=false;}
}
export async function route(){
  const parts=location.hash.replace(/^#\/?/,'').split('/');
  state.view=parts[0]==='settings'?'settings':'workspace';
  const id=state.view==='workspace'&&/^[\da-f-]{36}$/.test(parts[1]||'')?parts[1]:null;
  if(state.trackedJobId&&(state.view!=='workspace'||id))clearTrackedJob();
  if(id!==state.runId){state.runId=id;state.report=null;state.reportEtag='';state.actionId=null;state.tab='actions';state.image='after';state.findingFilter='needs_review';clearImages();}
  const action=/^[\da-f-]{36}$/.test(parts[2]||'')?parts[2]:null;if(action){state.actionId=action;state.tab='actions';}
  closeReportExport();state.drawer=null;render();await refresh();
  if(state.focusLaunch&&state.view==='workspace'&&!state.runId){state.focusLaunch=false;document.getElementById('target-url')?.focus();}
  if(state.openFindingsRun===state.runId){state.tab='findings';state.findingFilter='needs_review';state.openFindingsRun=null;render();}
}
export async function bootstrapSession(){
  try{
    const response=await fetch('/v1/auth-mode',{cache:'no-store',redirect:'error',signal:AbortSignal.timeout(5000)});
    if(!response.ok)throw new Error('Access mode unavailable.');
    const mode=(await response.json()).mode;
    state.spekiosAuth=mode==='spekios';
    state.developmentAccess=mode==='local_development';
    if(state.spekiosAuth){
      state.token='';sessionStorage.removeItem('scout.workspace-token');
      const identity=await fetch('/v1/identity',{cache:'no-store',redirect:'error'});
      state.browserAuth=identity.ok;
    }
  }catch{state.developmentAccess=false;}
  if(state.developmentAccess){state.token='';sessionStorage.removeItem('scout.workspace-token');}
  if(state.developmentAccess||state.browserAuth||state.token){state.connected=true;await route();}else login();
}
