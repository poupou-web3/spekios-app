// Demo-only instrumentation. Stable selectors describe interactions, not workflows.
let posthog=null,recording=false,completed=false;
const status=text=>{const element=document.getElementById('monitoring-status');if(element)element.textContent=text;};
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
  if(globalThis.__SPEKIOS_REPLAY__){status('Automated validation. This visit is excluded from analytics.');return;}
  try{
    const config=await fetch('/config.json').then(r=>r.json());
    if(!config.enabled){status('Demo monitoring is unavailable.');return;}
    if(!globalThis.posthog){status('Demo monitoring is unavailable.');return;}
    posthog=globalThis.posthog;
    posthog.init(config.token,{api_host:config.host,ui_host:config.uiHost||config.host,persistence:'memory',cross_subdomain_cookie:false,autocapture:true,capture_pageview:false,capture_pageleave:true,request_batching:false,disable_session_recording:true,opt_out_capturing_by_default:false,person_profiles:'never',disable_surveys:true,disable_external_dependency_loading:!config.toolbarEnabled,advanced_disable_feature_flags:true,session_recording:{maskAllInputs:true,maskTextSelector:'.private',recordCrossOriginIframes:false},loaded:instance=>{
      posthog=instance;globalThis.posthog=instance;
      // Clear the former demo's manual opt-out state, then record immediately.
      instance.opt_in_capturing({captureEventName:false});
      instance.register({spekios_demo:true,spekios_synthetic:false});
      instance.startSessionRecording({sampling:true});recording=true;
      pageview();checkpoint();
      status('Demo visits are recorded automatically. Only use fictional data.');
    }});
  }catch{status('Demo monitoring is unavailable.');}
  window.addEventListener('pagehide',event=>{
    if(!recording||completed||event.persisted)return;
    completed=true;
    posthog.capture('spekios_session_complete',{reason:'pagehide'},{transport:'sendBeacon',send_instantly:true});
  });
  document.addEventListener('click',event=>{
    const element=event.target.closest('[data-testid]');
    if(!recording||!element||element.tagName==='SELECT')return;
    posthog.capture('spekios_action',{action:'click',selector:`[data-testid="${element.dataset.testid}"]`,label:element.getAttribute('aria-label')||element.textContent.trim().slice(0,120)});
  },true);
  document.addEventListener('change',event=>{
    const element=event.target;
    // Only this explicitly designated fictional choice is captured unmasked.
    if(recording&&element.matches('select[data-replay-safe][data-testid]'))posthog.capture('spekios_action',{action:'select',selector:`[data-testid="${element.dataset.testid}"]`,label:'Choose '+element.name,value:element.value});
  });
}
