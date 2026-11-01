// Workspace entry: delegated DOM events, polling and startup. Rendering lives in app.js.
import {toast} from '/assets/ui/components.js';
import {signIn} from '/assets/ui/http.js';
import {bindThemeSwitch} from '/assets/ui/theme.js';
import {api,get} from './api.js';
import {bootstrapSession,refresh,render,route} from './app.js';
import {clearImages} from './images.js';
import {cancelWork,clearTrackedJob,continueWork,restartWork,submitJob} from './jobs.js';
import {closePrivateLogin,openPrivateLogin} from './private-login.js';
import {login} from './shell.js';
import {reviewDrafts,root,state,steeringDrafts} from './state.js';
import {navigateAction,selectedAction} from './views/action.js';
import {cancelAutomatic} from './views/automatic.js';
import {closeReportExport,downloadReport,openReportExport} from './views/export.js';
import {explorationRequest,updateTargetUrl} from './views/home.js';
import {submitReview,updateReviewDraft} from './views/review.js';
import {addCatalogModel,addSavedModel,editOverrides,numericFieldValue,rebaseConfiguration,removeSavedModel,saveConfiguration,updateConfiguration,updateNewModel} from './views/settings.js';
import {steeringDraft,submitSteering,updateSteeringFocus} from './views/steering.js';
import {rememberWorkspacePage} from './website-state.js';
import {bindWebsiteFavicons,clearWebsiteNavigation,launchUrlError,updateWebsiteLaunchHint,websiteHref} from './websites.js';
bindWebsiteFavicons(root);
root.addEventListener('submit',async e=>{
  e.preventDefault();
  if(e.target.id==='login-form'){
    const form=new FormData(e.target),email=String(form.get('email')||'').trim(),password=String(form.get('password')||'');state.error='';
    try{await signIn(email,password);state.token=password;await get('/readyz');sessionStorage.setItem('scout.workspace-token',state.token);state.connected=true;await route();}catch(error){state.token='';state.connected=false;if(!state.error)state.error=error.message==='Workspace access is required.'?'Email or password is incorrect.':error.message;login();}
  }else if(e.target.id==='website-launch-form'){
    const form=new FormData(e.target);form.set('viewport_profile',state.viewportProfile||state.settings.viewportProfile||'desktop');form.set('auth_mode','auto');
    const request=explorationRequest(form);state.websiteLaunchError=launchUrlError(request.target_url);
    if(state.websiteLaunchError){render();document.getElementById('website-url')?.focus();return;}
    await submitJob(request,{fromSwitcher:true});
    state.websiteLaunchError=state.launchError||state.error;
    if(state.websiteLaunchError){render();document.getElementById('website-url')?.focus();}
  }else if(e.target.id==='steering-form'){await submitSteering(e.target.dataset.runId);}else if(e.target.id==='exploration-configuration-form'){await saveConfiguration();}else if(e.target.id==='finding-review-form'){await submitReview(e.target.dataset.sourceAction);}else if(e.target.id==='run-form'){
    const form=new FormData(e.target),request=explorationRequest(form);state.launchError=launchUrlError(request.target_url);
    if(state.launchError){state.url=String(form.get('url')||'').trim();render();document.getElementById('target-url')?.focus();}else await submitJob(request);
  }
});
root.addEventListener('compositionstart',()=>{state.composing=true;});
root.addEventListener('compositionend',e=>{state.composing=false;captureInput(e.target);setTimeout(render,0);});
function captureInput(target){
  if(target.id==='steering-focus')return updateSteeringFocus(target.value);
  if(target.dataset.newModelField){if(target.type==='number'&&target.validity?.badInput)return false;return updateNewModel(target.dataset.newModelField,target.type==='number'?numericFieldValue(target.value):target.value);}
  if(target.dataset.configurationField){if(target.type==='number'&&target.validity?.badInput)return false;const field=target.dataset.configurationField,value=target.type==='checkbox'?target.checked:target.type==='number'?numericFieldValue(target.value):target.value;return updateConfiguration(field,value);}
  if(target.dataset.reviewField)updateReviewDraft(target.dataset.reviewAction,target.dataset.reviewField,target.value);
  if(target.id==='target-url')updateTargetUrl(target.value);
  if(target.id==='website-url'){state.websiteUrl=target.value;state.websiteLaunchError='';updateWebsiteLaunchHint(root,target.value);return false;}
  const field={'run-search':'search'}[target.id];
  if(field)state[field]=target.value;
  return !!field;
}
root.addEventListener('input',e=>{if(captureInput(e.target))render();});
root.addEventListener('change',e=>{if(e.target.id==='auto-reproduce'){state.autoReproduce=e.target.checked;sessionStorage.setItem('scout.auto-reproduce',String(state.autoReproduce));render();}if(e.target.dataset.reviewField){updateReviewDraft(e.target.dataset.reviewAction,e.target.dataset.reviewField,e.target.value);if(e.target.dataset.reviewField==='disposition')render();}if(e.target.id==='auth-mode'){state.authMode=e.target.value;if(state.authMode==='public')state.sessionId='';render();}if(e.target.id==='app-session')state.sessionId=e.target.value;if(e.target.id==='viewport-profile'){state.viewportProfile=e.target.value;render();}});
root.addEventListener('change',e=>{
  if(e.target.dataset.configurationField||e.target.dataset.newModelField){if(captureInput(e.target))render();return;}
  const field={'run-mode':'runMode'}[e.target.id];
  if(field){state[field]=e.target.value;render();}
});
root.addEventListener('click',async e=>{
  if(e.target.closest('a[href^="#/"]')&&state.trackedJobId)clearTrackedJob();
  const el=e.target.closest('[data-action]');if(!el)return;
  const action=el.dataset.action;
  if(action==='close-drawer'&&e.target.closest('.drawer')&&!e.target.closest('button[data-action="close-drawer"]'))return;
  if(el.tagName==='A')e.preventDefault();
  if(action==='focus-launch'){state.focusLaunch=true;if(state.view==='workspace'&&!state.runId&&state.websitePage==='overview'){state.focusLaunch=false;document.getElementById('target-url')?.focus();}else location.hash=websiteHref(state.websiteOrigin);}
  if(action==='open-findings'){state.openFindingsRun=el.dataset.id;if(state.runId===el.dataset.id){state.tab='findings';state.findingFilter='needs_review';state.openFindingsRun=null;rememberWorkspacePage();render();}else location.hash='#/workspace/'+el.dataset.id;}
  if(action==='run-filter'){state.runFilter=el.dataset.value;render();}
  if(action==='runs-page'){state.runOffset=Math.max(0,Number(el.dataset.offset)||0);await refresh();}
  if(action==='activity-view-run'){state.drawer=null;if(state.runId===el.dataset.id)render();else location.hash='#/workspace/'+el.dataset.id;}
  if(action==='open-activity'){closeReportExport();state.drawer={title:'Activity',activity:true};render();}
  if(action==='dismiss-tracked-job'){clearTrackedJob();render();}
  if(action==='cancel-automatic'||action==='retry-automatic')await cancelAutomatic(el.dataset.id);
  if(action==='cancel-run'||action==='cancel-job')await cancelWork(action==='cancel-run'?'run':'job',el.dataset.id);
  if(action==='restart-run'||action==='restart-job')await restartWork(action==='restart-run'?'run':'job',el.dataset.id);
  if(action==='continue-run')await continueWork(el.dataset.id);
  if(action==='app-login'||action==='create-account'){state.drawer=null;render();await openPrivateLogin(el.dataset.id,action==='create-account');}
  if(action==='skip-login'){try{await api('/v1/browser-access/'+el.dataset.id+'/skip',{});await refresh();}catch(error){toast(error.message);}}
  if(action==='cancel-login'){const access=state.access.requests.find(a=>a.access_id===el.dataset.id);if(access)await cancelWork('run',access.run_id);}
  if(action==='revoke-session'){try{await api('/v1/browser-sessions/'+el.dataset.id+'/revoke',{});if(state.sessionId===el.dataset.id)state.sessionId='';await refresh();toast('Saved session removed. A running browser remains signed in until it closes.');}catch(error){toast(error.message);}}
  if(action==='forget-memory'){try{await api('/v1/app-memory/'+el.dataset.id+'/forget',{});await refresh();toast('App memory forgotten. Recorded runs and evidence are unchanged.');}catch(error){toast(error.message);}}
  if(action==='refresh'){await refresh();if(state.connected&&!state.error)toast('Workspace refreshed.');}
  if(action==='logout'&&state.browserAuth){clearWebsiteNavigation();location.assign('/logout');return;}
  if(action==='logout'){closeReportExport();await closePrivateLogin(true);state.token='';state.developmentAccess=false;state.connected=false;state.report=null;state.reportEtag='';state.drawer=null;state.trackedJobId=null;sessionStorage.removeItem('scout.workspace-token');sessionStorage.removeItem('scout.pending-job');sessionStorage.removeItem('scout.tracked-job');clearWebsiteNavigation();state.websiteOrigin='';state.websites=[];state.runs=[];clearImages();state.error='';state.configurationDraft=null;reviewDrafts.clear();steeringDrafts.clear();login();}
  if(action==='discard-configuration'||action==='rebase-configuration'){rebaseConfiguration(action==='discard-configuration');render();}
  if(action==='add-limit-override'||action==='remove-limit-override'){editOverrides(action==='add-limit-override',Number(el.dataset.index));render();}
  // After adding, the model ID field is ready for the next one (or for fixing this one).
  if(action==='add-catalog-model'){addCatalogModel(el.dataset.provider,el.dataset.model);render();}
  if(action==='add-saved-model')addModelAndRefocus();
  if(action==='remove-saved-model'&&removeSavedModel(Number(el.dataset.index)))render();
  if(action==='prev-action'||action==='next-action'){navigateAction(action==='prev-action'?-1:1,el.dataset.id);}
  if(action==='settling-frame'){state.image='frame';state.frameId=el.dataset.id;render();}
  if(action==='outcome-json'){state.drawer={title:'Action completion and diagnostics',raw:{outcome:selectedAction()?.outcome,frames:(state.report.events||[]).filter(e=>e.action_id===state.actionId&&e.event_type==='action.settling_frame').map(e=>e.payload)}};render();}
  if(action==='tab'){state.tab=el.dataset.value;rememberWorkspacePage();render();}
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
document.addEventListener('click',e=>{if(e.target.closest?.('.skip-link')){e.preventDefault();const main=document.getElementById('main-content');main?.focus();main?.scrollIntoView({block:'start'});}if(!e.target.closest?.('.website-switcher')){const switcher=root.querySelector?.('.website-switcher[open]');if(switcher)switcher.open=false;}});
document.addEventListener('keydown',e=>{
  // Enter in the add-a-model fields adds the model; it never saves the whole form.
  if(e.key==='Enter'&&!e.isComposing&&e.target.dataset?.newModelField){e.preventDefault();addModelAndRefocus();return;}
  if(e.key==='Escape'&&state.drawer){e.preventDefault();closeReportExport();state.drawer=null;render();return;}
  if(e.key==='Escape'){const switcher=root.querySelector?.('.website-switcher[open]');if(switcher){e.preventDefault();switcher.open=false;switcher.querySelector('summary')?.focus();return;}}
  if(e.key==='Tab'&&state.drawer){
    const elements=Array.from(root.querySelectorAll('.drawer button:not(:disabled),.drawer a[href],.drawer input:not(:disabled),.drawer select:not(:disabled),.drawer [tabindex="0"]'));
    const first=elements[0],last=elements.at(-1);
    if(first&&(e.shiftKey&&document.activeElement===first||!e.shiftKey&&document.activeElement===last)){e.preventDefault();(e.shiftKey?last:first).focus();}
  }
  const tab=e.target.closest?.('[role="tab"][data-action="tab"]');
  if(tab&&['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){
    e.preventDefault();const tabs=['actions','findings','flow'],i=tabs.indexOf(state.tab);
    state.tab=e.key==='Home'?tabs[0]:e.key==='End'?tabs.at(-1):tabs[(i+(e.key==='ArrowRight'?1:tabs.length-1))%tabs.length];rememberWorkspacePage();render();document.getElementById('run-tab-'+state.tab)?.focus();
  }
});
// Blurring first sends the field's pending change before the fields clear; otherwise Chrome fires it
// during the redraw and puts the old text back. The model ID field is then ready for the next model.
function addModelAndRefocus(){document.activeElement?.blur?.();addSavedModel();render();document.getElementById('new-model-model')?.focus();}
window.addEventListener('hashchange',route);
setInterval(()=>{if(state.connected&&!document.hidden&&(!state.drawer||state.drawer.activity)&&!state.submitting)void refresh();},5000);
bindThemeSwitch(root);
if(document.readyState==='complete')void bootstrapSession();
else window.addEventListener('DOMContentLoaded',()=>void bootstrapSession(),{once:true});
