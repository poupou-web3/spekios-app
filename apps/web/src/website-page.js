// Keep the selected website visible when opening the separately served customer pages.
import {bindWebsiteFavicons,browserTargetUrl,groupWebsites,launchUrlError,rememberWebsiteShortcut,savedWebsite,saveWebsite,updateWebsiteLaunchHint,websiteLabel,websiteOrigin,websiteSidebar} from './websites.js';

export async function mountWebsitePage({page,request}){
  const slot=document.querySelector('[data-workspace-sidebar]');
  if(slot?.dataset?.workspaceSidebar===undefined)return null;
  let origin=websiteOrigin(new URLSearchParams(location.search).get('origin'))||savedWebsite(),websites=[],runs=[],draft='',error='',submitting=false;
  const catalog=await request('/v1/runs');websites=groupWebsites(catalog.websites||[],catalog.runs||[]);runs=catalog.runs||[];
  if(!origin)origin=websites[0]?.origin||'';
  saveWebsite(origin);if(page==='issues')rememberWebsiteShortcut(origin,'issues');
  bindWebsiteFavicons(slot);
  function draw(open=false){
    slot.innerHTML=websiteSidebar({websites,origin,page,runs:runs.filter(run=>websiteOrigin(run.target_url)===origin),external:true,newUrl:draft,error,submitting});
    const disclosure=slot.querySelector('details');if(disclosure)disclosure.open=open;
  }
  slot.addEventListener('input',event=>{if(event.target.id==='website-url'){draft=event.target.value;error='';updateWebsiteLaunchHint(slot,draft);}});
  slot.addEventListener('submit',async event=>{
    if(event.target.id!=='website-launch-form')return;event.preventDefault();if(submitting)return;
    const target=browserTargetUrl(draft);error=launchUrlError(target);if(error){draw(true);slot.querySelector('input')?.focus();return;}
    const spec={kind:'explore',target_url:target,auth_mode:'auto'};
    let pending;try{pending=JSON.parse(sessionStorage.getItem('scout.pending-job')||'null');}catch{}
    if(!pending||JSON.stringify(pending.request)!==JSON.stringify(spec))pending={request:spec,job_id:crypto.randomUUID()};
    sessionStorage.setItem('scout.pending-job',JSON.stringify(pending));submitting=true;error='';draw(true);
    try{
      const result=await request('/v1/browser-jobs',{job_id:pending.job_id,...spec});
      sessionStorage.removeItem('scout.pending-job');saveWebsite(websiteOrigin(target));
      if(result.job?.job_id)sessionStorage.setItem('scout.tracked-job',result.job.job_id);
      location.assign('/#/workspace');
    }catch(e){error=e.message;submitting=false;draw(true);slot.querySelector('input')?.focus();}
  });
  document.addEventListener('click',event=>{if(!event.target.closest?.('.website-switcher')){const details=slot.querySelector('details');if(details)details.open=false;}});
  document.addEventListener('keydown',event=>{const details=slot.querySelector('details');if(event.key==='Escape'&&details?.open){event.preventDefault();details.open=false;details.querySelector('summary')?.focus();}});
  draw();
  return {
    get origin(){return origin;},
    selectForUrl(value){
      const selected=websiteOrigin(value);if(!selected||selected===origin)return false;
      origin=selected;saveWebsite(origin);rememberWebsiteShortcut(origin,'issues');
      const url=new URL(location.href);url.searchParams.set('origin',origin);history.replaceState(null,'',url);
      draw();return true;
    },
    label(){return websiteLabel(origin);},
  };
}
