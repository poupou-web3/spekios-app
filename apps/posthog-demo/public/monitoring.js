// Demo-only instrumentation. Stable selectors describe interactions, not workflows.
let posthog=null,recording=false,ready=false;
const status=text=>{document.getElementById('monitoring-status').textContent=text;};
export const isRecording=()=>recording;
export function pageview(){if(recording)posthog.capture('$pageview',{$current_url:location.origin+location.pathname});}
export function checkpoint(){
  if(!recording)return;
  for(const element of document.querySelectorAll('[data-checkpoint][data-testid]')){
    if(!element.getClientRects().length)continue;
    const value=element.textContent.replace(/\s+/g,' ').trim();
    if(value&&value.length<=300)posthog.capture('spekios_checkpoint',{selector:`[data-testid="${element.dataset.testid}"]`,value,label:element.dataset.checkpoint});
  }
}
export async function setupMonitoring(){
  const start=document.getElementById('start-recording'),finish=document.getElementById('finish-recording');
  if(globalThis.__SPEKIOS_REPLAY__){start.disabled=true;status('Automated validation. This visit is excluded from analytics.');return;}
  try{
    const config=await fetch('/config.json').then(r=>r.json());
    if(!config.enabled){start.disabled=true;status('Monitoring is not configured yet. Add this demo’s PostHog host and public project token to its own environment.');return;}
    if(!globalThis.posthog){start.disabled=true;status('The monitoring SDK did not load.');return;}
    posthog=globalThis.posthog;
    posthog.init(config.token,{api_host:config.host,ui_host:config.uiHost||config.host,persistence:'memory',cross_subdomain_cookie:false,autocapture:!!config.toolbarEnabled,capture_pageview:false,capture_pageleave:false,request_batching:false,disable_session_recording:true,opt_out_capturing_by_default:true,person_profiles:'never',disable_surveys:true,disable_external_dependency_loading:!config.toolbarEnabled,advanced_disable_feature_flags:true,session_recording:{maskAllInputs:true,maskTextSelector:'.private',recordCrossOriginIframes:false},loaded:instance=>{posthog=instance;globalThis.posthog=instance;ready=true;}});
    status('Ready. Recording starts only when you choose “Start recorded visit”.');
  }catch{start.disabled=true;status('Monitoring could not start. Check this demo’s PostHog configuration.');}
  start.addEventListener('click',()=>{
    if(!ready){status('The monitoring SDK is still loading. Try again shortly.');return;}
    posthog.reset();posthog.opt_in_capturing({captureEventName:false});posthog.register({spekios_demo:true,spekios_synthetic:false});posthog.startSessionRecording({sampling:true});recording=true;pageview();
    start.disabled=true;finish.disabled=false;document.getElementById('recording-title').textContent='Visit is recording';status('Explore the collection and place a demo order. Then finish your visit.');
  });
  finish.addEventListener('click',()=>{
    if(!recording)return;
    posthog.capture('spekios_session_complete',{}, {send_instantly:true});posthog.stopSessionRecording();recording=false;
    // Keep capturing opted in long enough for the recorder's final upload;
    // application events are gated by `recording` and the next start resets ID.
    start.disabled=false;finish.disabled=true;document.getElementById('recording-title').textContent='Visit finished';status('Your visit was sent to PostHog. Spekios will import it in the background. Delivery can take a few minutes.');
  });
  document.addEventListener('click',event=>{
    const element=event.target.closest('[data-testid]');
    if(!recording||!element||['start-recording','finish-recording'].includes(element.dataset.testid)||element.tagName==='SELECT')return;
    posthog.capture('spekios_action',{action:'click',selector:`[data-testid="${element.dataset.testid}"]`,label:element.getAttribute('aria-label')||element.textContent.trim().slice(0,120)});
  },true);
  document.addEventListener('change',event=>{
    const element=event.target;
    // Only this explicitly designated fictional choice is captured unmasked.
    if(recording&&element.matches('select[data-replay-safe][data-testid]'))posthog.capture('spekios_action',{action:'select',selector:`[data-testid="${element.dataset.testid}"]`,label:'Choose '+element.name,value:element.value});
  },true);
}
