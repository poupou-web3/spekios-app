// Rendering, data refresh and hash routing for the workspace (#/workspace, #/workspace/<run>[/<action>], #/settings[/<section>]).
import {get} from './api.js';
import {clearImages,loadImages} from './images.js';
import {clearTrackedJob,followSubmittedJob} from './jobs.js';
import {closePrivateLogin,privateLogin} from './private-login.js';
import {login,shell} from './shell.js';
import {root,state} from './state.js';
import {closeReportExport} from './views/export.js';
import {home} from './views/home.js';
import {runView} from './views/run.js';
import {SETTINGS_SECTIONS,applyConfiguration,focusPriceTarget,settingsView} from './views/settings.js';
import {mergeSteering} from './views/steering.js';
import {rememberWorkspacePage,selectWebsite} from './website-state.js';
import {savedWebsite,websiteOrigin} from './websites.js';
let refreshing = false, refreshAgain = false, renderIdentity = '', drawerOpener = null, rendering = false, renderAgain = false;
export function render(){
  if(!state.connected){login();return;}
  if(state.composing)return;
  const focused=document.activeElement;
  // "0." is not a number yet. Replacing the field would delete the decimal the person is typing.
  if(focused?.type==='number'&&focused.validity?.badInput)return;
  // Replacing a focused field makes Chrome fire its pending change event inside the replacement.
  // A handler that renders from there would replace the same nodes again, so it waits for this pass.
  if(rendering){renderAgain=true;return;}
  // Number inputs expose no caret. Reading selectionStart throws in some browsers.
  let selection=null;try{if(typeof focused?.selectionStart==='number')selection=[focused.selectionStart,focused.selectionEnd,focused.selectionDirection];}catch{}
  const focusId=focused?.id;
  const focusKey=focused?.dataset?.action?{...focused.dataset}:null,identity=[state.view,state.websiteOrigin,state.websitePage,state.runId,state.tab,state.settingsSection].join(':');
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
  if(input){
    input.focus({preventScroll:true});
    if(selection){try{input.setSelectionRange(...selection);}catch{}}
    // A replaced number field focuses with the caret on the first digit, so the next key is inserted in front and the digit is covered.
    else if(input.type==='number'){const value=input.value;input.value='';input.value=value;}
  }
  if(state.drawer&&!hadDrawer)root.querySelector?.('.drawer button')?.focus();
  if(!state.drawer&&hadDrawer){
    const opener=drawerOpener?.id?document.getElementById(drawerOpener.id):drawerOpener?.key?Array.from(root.querySelectorAll('[data-action]')).find(n=>Object.keys(drawerOpener.key).every(key=>n.dataset[key]===drawerOpener.key[key])):null;
    (opener||input||document.getElementById?.('main-content'))?.focus({preventScroll:true});drawerOpener=null;
  }
  void loadImages();
  if(renderAgain){renderAgain=false;render();}
}
export async function refresh(){
  if(refreshing){refreshAgain=true;return;}if(!state.token&&!state.developmentAccess&&!state.browserAuth)return;refreshing=true;
  const token=state.token,developmentAccess=state.developmentAccess,browserAuth=state.browserAuth;
  const origin=state.websiteOrigin,offset=state.runOffset;
  const runsPath='/v1/runs'+(origin?'?origin='+encodeURIComponent(origin)+'&offset='+offset:'');
  try{
    const [runs,jobs,providers,access]=await Promise.all([runsPath,'/v1/browser-jobs','/v1/model-providers','/v1/browser-access'].map(get));
    if((token!==state.token||developmentAccess!==state.developmentAccess||browserAuth!==state.browserAuth))return;
    if(origin!==state.websiteOrigin||offset!==state.runOffset)return;
    // Memory is shown only in Settings → Memory & sessions; other views do not poll it.
    if(state.view==='settings'&&state.settingsSection==='data'){try{const memory=await get('/v1/app-memory');if(token===state.token&&developmentAccess===state.developmentAccess&&browserAuth===state.browserAuth){state.memory=memory;state.memoryError='';}}catch(error){if(token===state.token&&developmentAccess===state.developmentAccess&&browserAuth===state.browserAuth)state.memoryError=error.message;}}
    state.runs=runs.runs;state.websites=runs.websites||[];state.runTotal=runs.total??runs.runs.length;state.runNextOffset=runs.next_offset??null;state.runListOrigin=origin;state.jobs=jobs.jobs;state.workers=jobs.workers;applyConfiguration({settings:jobs.settings,revision:jobs.settings_revision??jobs.settings?.settingsRevision??0});state.providers=providers;state.access=access;
    if(!state.websiteOrigin&&!state.runId){const first=state.websites[0];if(first){selectWebsite(first.origin,{prefill:!state.url});}}
    if(privateLogin&&!access.requests.some(a=>a.access_id===privateLogin.id&&['waiting','active'].includes(a.status)))await closePrivateLogin(false);
    if(state.runId){const id=state.runId;const headers=state.reportEtag&&state.report?.run?.run_id===id?{'If-None-Match':state.reportEtag}:{};const report=await get('/v1/runs/'+id, headers);if((token!==state.token||developmentAccess!==state.developmentAccess||browserAuth!==state.browserAuth))return;if(report&&id===state.runId){if(typeof report._etag==='string'){state.reportEtag=report._etag;delete report._etag;}report.steering=mergeSteering(report.steering,state.report?.steering);state.report=report;if(!report.actions.some(a=>a.action_id===state.actionId))state.actionId=(report.actions.find(a=>a.assessment?.verdict==='suspect')||report.actions.at(-1))?.action_id;}}
    if(state.report?.run&&state.report.run.run_id===state.runId)selectWebsite(state.report.run.target_url);
    state.error='';state.connected=true;state.lastUpdatedAt=new Date().toISOString();rememberWorkspacePage();render();
    // A price link may arrive during polling. Focus only after the saved models have loaded.
    if(state.view==='settings'&&state.settingsSection==='models')focusPriceTarget();
    followSubmittedJob();
  }catch(error){if((token===state.token&&developmentAccess===state.developmentAccess&&browserAuth===state.browserAuth)){state.error=error.message;render();}}finally{refreshing=false;if(refreshAgain||origin!==state.websiteOrigin||offset!==state.runOffset){refreshAgain=false;void refresh();}}
}
export async function route(){
  const parts=location.hash.replace(/^#\/?/,'').split('/');
  state.priceTarget=null;
  state.view=parts[0]==='settings'?'settings':'workspace';
  state.websitePage=parts[0]==='website'&&parts[2]==='tests'?'tests':'overview';
  if(state.websitePage!=='tests')state.runOffset=0;
  if(parts[0]==='website'){let origin='';try{origin=websiteOrigin(decodeURIComponent(parts[1]||''));}catch{}if(origin)selectWebsite(origin,{prefill:origin!==state.websiteOrigin});}
  else if(!state.websiteOrigin){const saved=savedWebsite();if(saved)selectWebsite(saved,{prefill:!state.url});}
  // Each settings section is its own page, opened at the top. Unknown sections show the first.
  if(state.view==='settings'){const section=SETTINGS_SECTIONS.some(([key])=>key===parts[1])?parts[1]:SETTINGS_SECTIONS[0][0];if(section!==state.settingsSection){state.settingsSection=section;window.scrollTo?.(0,0);}
    // #/settings/models/price/<provider|model> opens at that model's prices; the address then drops the target.
    if(section==='models'&&parts[2]==='price'&&parts[3]){try{state.priceTarget=decodeURIComponent(parts[3]);}catch{state.priceTarget=null;}window.history?.replaceState?.(null,'','#/settings/models');}}
  const id=state.view==='workspace'&&/^[\da-f-]{36}$/.test(parts[1]||'')?parts[1]:null;
  if(state.trackedJobId&&(state.view!=='workspace'||id))clearTrackedJob();
  if(id!==state.runId){state.runId=id;state.report=null;state.reportEtag='';state.actionId=null;state.tab='actions';state.image='after';state.findingFilter='needs_review';clearImages();}
  const action=/^[\da-f-]{36}$/.test(parts[2]||'')?parts[2]:null;if(action){state.actionId=action;state.tab='actions';}
  if(id&&['findings','flow'].includes(parts[2]))state.tab=parts[2];
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
