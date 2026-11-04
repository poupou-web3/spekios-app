// Back office entry: delegated DOM events, polling and startup.
import {toast} from '/assets/ui/components.js';
import {bindThemeSwitch} from '/assets/ui/theme.js';
import {api,get} from './api.js';
import {bootstrapSession,login,refresh,render,route,selectTab,tabHash} from './app.js';
import {TABS,root,state} from './state.js';
import {cancelWork} from './views/jobs.js';
import {freshLogs,loadLogs,olderLogs,pollLogs} from './views/logs.js';
let logSearch=0;
root.addEventListener('submit',async e=>{
  e.preventDefault();
  if(e.target.id==='demo-settings-form'){
    if(state.submitting)return;
    const form=new FormData(e.target),secret=String(form.get('api_key')||'');
    e.target.querySelector('#demo-api-key').value='';form.delete('api_key');
    state.demoDraft={enabled:form.has('enabled'),allowance_usd:String(form.get('allowance_usd'))};
    state.submitting=true;state.demoError='';state.demoMessage='';render();
    try{
      await api('/v1/admin/demo',{expected_revision:state.demo.revision,model:'muse-spark-1.3-contributor',enabled:state.demoDraft.enabled,allowance_usd:Number(state.demoDraft.allowance_usd),...(secret?{api_key:secret}:{})});
      state.demo=await get('/v1/admin/demo');state.demoDraft=null;state.demoMessage='Demo settings saved. Personal models and keys remain available.';
    }catch(error){state.demoError=error.code==='revision_conflict'?'Another operator changed these settings. Refresh and review the latest revision before saving.':error.message;}
    finally{state.submitting=false;render();}return;
  }
  if(e.target.id!=='login-form')return;
  state.token=new FormData(e.target).get('token').trim();state.error='';
  try{await get('/readyz');sessionStorage.setItem('scout.backoffice-token',state.token);state.connected=true;await route();}catch(error){state.error=error.message;login();}
});
root.addEventListener('compositionstart',()=>{state.composing=true;});
root.addEventListener('compositionend',e=>{state.composing=false;captureInput(e.target);setTimeout(render,0);});
function captureInput(target){
  if(target.id==='demo-allowance'||target.id==='demo-enabled'){
    state.demoDraft??={enabled:state.demo?.enabled===true,allowance_usd:state.demo?.allowance_usd??1};
    state.demoDraft[target.id==='demo-enabled'?'enabled':'allowance_usd']=target.id==='demo-enabled'?target.checked:target.value;
    return false;
  }
  const field={'event-search':'eventSearch','job-search':'jobSearch','model-search':'modelSearch'}[target.id];
  if(field)state[field]=target.value;
  return !!field;
}
root.addEventListener('input',e=>{
  // Searching reloads the newest matching lines once typing pauses.
  if(e.target.id==='log-search'){state.logs.q=e.target.value;clearTimeout(logSearch);logSearch=setTimeout(()=>void loadLogs(),350);return;}
  if(captureInput(e.target))render();
});
root.addEventListener('change',e=>{
  if(e.target.id==='ops-run'){state.runId=e.target.value||null;location.hash=tabHash();return;}
  if(e.target.id==='log-level'){state.logs.level=e.target.value;void loadLogs();return;}
  if(e.target.id==='log-run-only'){state.logs.runOnly=e.target.checked;void loadLogs();return;}
  const field={'job-filter':'jobFilter','job-mode':'jobMode','model-provider':'modelProvider','model-status':'modelStatus','model-purpose':'modelPurpose'}[e.target.id];
  if(field){state[field]=e.target.value;render();}
});
root.addEventListener('toggle',e=>{
  if(e.target.dataset.event){if(e.target.open)state.expanded.add(e.target.dataset.event);else state.expanded.delete(e.target.dataset.event);}
  if(e.target.dataset.log){if(e.target.open)state.logs.expanded.add(e.target.dataset.log);else state.logs.expanded.delete(e.target.dataset.log);}
},true);
// Scrolling up in the log list stops following the tail; returning to the bottom resumes it.
root.addEventListener('scroll',e=>{
  const list=e.target;if(!list?.classList?.contains('log-list'))return;
  const bottom=list.scrollHeight-list.scrollTop-list.clientHeight<24;
  if(bottom!==state.logs.follow){state.logs.follow=bottom;if(bottom)state.logs.unseen=0;render();}
},true);
root.addEventListener('click',async e=>{
  const el=e.target.closest('[data-action]');if(!el)return;
  const action=el.dataset.action;
  if(action==='close-drawer'&&e.target.closest('.drawer')&&!e.target.closest('button[data-action="close-drawer"]'))return;
  if(el.tagName==='A')e.preventDefault();
  if(action==='ops-tab')selectTab(el.dataset.value);
  if(action==='refresh'){await refresh();if(state.connected&&!state.error)toast('Back office refreshed.');}
  if(action==='log-live'){state.logs.live=!state.logs.live;render();if(state.logs.live)void pollLogs();}
  if(action==='log-service'){const name=el.dataset.service;if(state.logs.exclude.has(name))state.logs.exclude.delete(name);else state.logs.exclude.add(name);void loadLogs();}
  if(action==='log-older')void olderLogs();
  if(action==='log-latest'){state.logs.follow=true;state.logs.unseen=0;render();}
  if(action==='log-clear'){Object.assign(state.logs,{rows:[],ids:new Set(),expanded:new Set(),hasOlder:false,unseen:0,follow:true,cleared:new Date().toISOString()});render();}
  if(action==='log-run'){const run=el.dataset.run;state.logs.runOnly=true;if(run===state.runId)void loadLogs();else location.hash='#/logs/'+run;}
  if(action==='logout'){state.logs=freshLogs({generation:state.logs.generation});state.token='';state.developmentAccess=false;state.connected=false;state.report=null;state.reportEtag='';state.drawer=null;state.error='';sessionStorage.removeItem('scout.backoffice-token');login();}
  if(action==='cancel-run'||action==='cancel-job')await cancelWork(action==='cancel-run'?'run':'job',el.dataset.id);
  if(action==='job-error'){state.drawer={title:'Browser job',raw:state.jobs.find(j=>j.job_id===el.dataset.id)};render();}
  if(action==='job-lineage'){const job=state.jobs.find(j=>j.job_id===el.dataset.id);state.drawer={title:'Automatic reproduction lineage',raw:{parent_job_id:job?.parent_job_id,source_action_id:job?.automatic_source_action_id,child_job_id:job?.job_id,note:'The parent job is outside the recent queue view. Inspect the child run to follow its source action.'}};render();}
  if(action==='model'){const id=el.dataset.id;state.drawer={title:'Model call details',id,loading:true};render();try{const model=await get('/v1/model-requests/'+id);if(state.drawer?.id===id)state.drawer={title:'Model call details',id,model};}catch(error){if(state.drawer?.id===id)state.drawer={title:'Model call details',id,error:error.message};}render();}
  if(action==='close-drawer'){state.drawer=null;render();}
});
document.addEventListener('click',e=>{if(e.target.closest?.('.skip-link')){e.preventDefault();const main=document.getElementById('main-content');main?.focus();main?.scrollIntoView({block:'start'});}});
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'&&state.drawer){e.preventDefault();state.drawer=null;render();return;}
  if(e.key==='Tab'&&state.drawer){
    const elements=Array.from(root.querySelectorAll('.drawer button:not(:disabled),.drawer a[href],.drawer input:not(:disabled),.drawer select:not(:disabled),.drawer [tabindex="0"]'));
    const first=elements[0],last=elements.at(-1);
    if(first&&(e.shiftKey&&document.activeElement===first||!e.shiftKey&&document.activeElement===last)){e.preventDefault();(e.shiftKey?last:first).focus();}
  }
  const tab=e.target.closest?.('[role="tab"][data-action="ops-tab"]');
  if(tab&&['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){
    e.preventDefault();const i=TABS.indexOf(state.opsTab);
    selectTab(e.key==='Home'?TABS[0]:e.key==='End'?TABS.at(-1):TABS[(i+(e.key==='ArrowRight'?1:TABS.length-1))%TABS.length]);document.getElementById('ops-tab-'+state.opsTab)?.focus();
  }
});
window.addEventListener('hashchange',route);
setInterval(()=>{if(state.connected&&!document.hidden&&!state.drawer&&!state.submitting)void refresh();},5000);
setInterval(()=>{if(state.connected&&state.opsTab==='logs'&&!document.hidden)void pollLogs();},1500);
bindThemeSwitch(root);
if(document.readyState==='complete')void bootstrapSession();
else window.addEventListener('DOMContentLoaded',()=>void bootstrapSession(),{once:true});
