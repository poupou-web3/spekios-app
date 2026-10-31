// Workspace entry: delegated DOM events, polling and startup. Rendering lives in app.js.
import {toast} from '/assets/ui/components.js';
import {bindThemeSwitch} from '/assets/ui/theme.js';
import {api,get} from './api.js';
import {bootstrapSession,refresh,render,route} from './app.js';
import {clearImages} from './images.js';
import {cancelWork,clearTrackedJob,submitJob} from './jobs.js';
import {closePrivateLogin,openPrivateLogin} from './private-login.js';
import {login} from './shell.js';
import {reviewDrafts,root,state,steeringDrafts} from './state.js';
import {navigateAction,selectedAction} from './views/action.js';
import {cancelAutomatic} from './views/automatic.js';
import {closeReportExport,downloadReport,openReportExport} from './views/export.js';
import {explorationRequest,launchUrlError,updateTargetUrl} from './views/home.js';
import {submitReview,updateReviewDraft} from './views/review.js';
import {editOverrides,rebaseConfiguration,saveConfiguration,updateConfiguration} from './views/settings.js';
import {steeringDraft,submitSteering,updateSteeringFocus} from './views/steering.js';
root.addEventListener('submit',async e=>{
  e.preventDefault();
  if(e.target.id==='login-form'){
    state.token=new FormData(e.target).get('token').trim();state.error='';
    try{await get('/readyz');sessionStorage.setItem('scout.workspace-token',state.token);state.connected=true;await route();}catch(error){state.error=error.message;login();}
  }else if(e.target.id==='steering-form'){await submitSteering(e.target.dataset.runId);}else if(e.target.id==='exploration-configuration-form'){await saveConfiguration();}else if(e.target.id==='finding-review-form'){await submitReview(e.target.dataset.sourceAction);}else if(e.target.id==='run-form'){
    const form=new FormData(e.target),request=explorationRequest(form);state.launchError=launchUrlError(request.target_url);
    if(state.launchError){state.url=String(form.get('url')||'').trim();render();document.getElementById('target-url')?.focus();}else await submitJob(request);
  }
});
root.addEventListener('compositionstart',()=>{state.composing=true;});
root.addEventListener('compositionend',e=>{state.composing=false;captureInput(e.target);setTimeout(render,0);});
function captureInput(target){
  if(target.id==='steering-focus')return updateSteeringFocus(target.value);
  if(target.dataset.configurationField){const field=target.dataset.configurationField,value=target.type==='checkbox'?target.checked:target.type==='number'?(target.value===''?null:Number(target.value)):target.value;return updateConfiguration(field,value);}
  if(target.dataset.reviewField)updateReviewDraft(target.dataset.reviewAction,target.dataset.reviewField,target.value);
  if(target.id==='target-url')updateTargetUrl(target.value);
  const field={'run-search':'search'}[target.id];
  if(field)state[field]=target.value;
  return !!field;
}
root.addEventListener('input',e=>{if(captureInput(e.target))render();});
root.addEventListener('change',e=>{if(e.target.id==='auto-reproduce'){state.autoReproduce=e.target.checked;sessionStorage.setItem('scout.auto-reproduce',String(state.autoReproduce));render();}if(e.target.dataset.reviewField){updateReviewDraft(e.target.dataset.reviewAction,e.target.dataset.reviewField,e.target.value);if(e.target.dataset.reviewField==='disposition')render();}if(e.target.id==='auth-mode'){state.authMode=e.target.value;if(state.authMode==='public')state.sessionId='';render();}if(e.target.id==='app-session')state.sessionId=e.target.value;if(e.target.id==='viewport-profile'){state.viewportProfile=e.target.value;render();}});
root.addEventListener('change',e=>{
  if(e.target.dataset.configurationField){if(captureInput(e.target))render();return;}
  const field={'run-mode':'runMode'}[e.target.id];
  if(field){state[field]=e.target.value;render();}
});
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
  if(action==='cancel-automatic'||action==='retry-automatic')await cancelAutomatic(el.dataset.id);
  if(action==='cancel-run'||action==='cancel-job')await cancelWork(action==='cancel-run'?'run':'job',el.dataset.id);
  if(action==='app-login')await openPrivateLogin(el.dataset.id);
  if(action==='skip-login'){try{await api('/v1/browser-access/'+el.dataset.id+'/skip',{});await refresh();}catch(error){toast(error.message);}}
  if(action==='cancel-login'){const access=state.access.requests.find(a=>a.access_id===el.dataset.id);if(access)await cancelWork('run',access.run_id);}
  if(action==='revoke-session'){try{await api('/v1/browser-sessions/'+el.dataset.id+'/revoke',{});if(state.sessionId===el.dataset.id)state.sessionId='';await refresh();toast('Saved session removed. A running browser remains signed in until it closes.');}catch(error){toast(error.message);}}
  if(action==='forget-memory'){try{await api('/v1/app-memory/'+el.dataset.id+'/forget',{});await refresh();toast('App memory forgotten. Recorded runs and evidence are unchanged.');}catch(error){toast(error.message);}}
  if(action==='refresh'){await refresh();if(state.connected&&!state.error)toast('Workspace refreshed.');}
  if(action==='logout'){closeReportExport();await closePrivateLogin(true);state.token='';state.developmentAccess=false;state.connected=false;state.report=null;state.reportEtag='';state.drawer=null;state.trackedJobId=null;sessionStorage.removeItem('scout.workspace-token');sessionStorage.removeItem('scout.pending-job');sessionStorage.removeItem('scout.tracked-job');clearImages();state.error='';state.configurationDraft=null;reviewDrafts.clear();steeringDrafts.clear();login();}
  if(action==='discard-configuration'||action==='rebase-configuration'){rebaseConfiguration(action==='discard-configuration');render();}
  if(action==='add-limit-override'||action==='remove-limit-override'){editOverrides(action==='add-limit-override',Number(el.dataset.index));render();}
  if(action==='prev-action'||action==='next-action'){navigateAction(action==='prev-action'?-1:1,el.dataset.id);}
  if(action==='settling-frame'){state.image='frame';state.frameId=el.dataset.id;render();}
  if(action==='outcome-json'){state.drawer={title:'Action completion and diagnostics',raw:{outcome:selectedAction()?.outcome,frames:(state.report.events||[]).filter(e=>e.action_id===state.actionId&&e.event_type==='action.settling_frame').map(e=>e.payload)}};render();}
  if(action==='tab'){state.tab=el.dataset.value;render();}
  if(action==='finding-filter'){state.findingFilter=el.dataset.value;render();}
  if(action==='image'){state.image=el.dataset.value;render();}
  if(action==='zoom-image'&&/^\/v1\/(?:captures\/[\da-f-]{36}\/image|artifacts\/[\da-f-]{36}\/content)$/.test(el.dataset.path||'')){state.drawer={title:'Recorded screenshot',image:{path:el.dataset.path,alt:el.dataset.alt,fit:false}};render();}
  if(action==='image-scale'&&state.drawer?.image){state.drawer.image.fit=!state.drawer.image.fit;render();}
  if(action==='select-action'){state.actionId=el.dataset.id;if(state.tab==='flow'||el.dataset.sourceAction)state.tab='actions';state.image='after';render();}
  if(action==='copy'){try{await navigator.clipboard.writeText(el.dataset.value);toast('ID copied.');}catch{toast('Clipboard unavailable. Select and copy the visible ID.');}}
  if(action==='reset-steering'||action==='rebase-steering'){const d=steeringDraft();if(!d.busy&&!d.command){d.revision=state.report?.steering?.revision||0;d.error='';if(action==='reset-steering'){d.dirty=false;steeringDraft();}render();}}
  if(action==='reproduce')await submitJob({kind:'reproduce',source_action_id:el.dataset.id});
  if(action==='action-json'){state.drawer={title:'Action record',raw:selectedAction()};render();}
  if(action==='close-drawer'){closeReportExport();state.drawer=null;render();}
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
  const tab=e.target.closest?.('[role="tab"][data-action="tab"]');
  if(tab&&['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){
    e.preventDefault();const tabs=['actions','findings','flow'],i=tabs.indexOf(state.tab);
    state.tab=e.key==='Home'?tabs[0]:e.key==='End'?tabs.at(-1):tabs[(i+(e.key==='ArrowRight'?1:tabs.length-1))%tabs.length];render();document.getElementById('run-tab-'+state.tab)?.focus();
  }
});
window.addEventListener('hashchange',route);
setInterval(()=>{if(state.connected&&!document.hidden&&!state.drawer&&!state.submitting)void refresh();},5000);
bindThemeSwitch(root);
if(document.readyState==='complete')void bootstrapSession();
else window.addEventListener('DOMContentLoaded',()=>void bootstrapSession(),{once:true});
