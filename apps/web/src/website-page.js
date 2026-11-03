// Keep the selected website visible when opening the separately served customer pages.
import {bindThemeSwitch} from '/assets/ui/theme.js';
import {accountMenuMarkup} from './account-menu.js';
import {setNotificationsEnabled} from './notifications.js';
import {bindWebsiteFavicons,browserTargetUrl,clearWebsiteNavigation,groupWebsites,launchUrlError,rememberWebsiteShortcut,savedWebsite,saveWebsite,updateWebsiteLaunchHint,websiteHref,websiteLabel,websiteOrigin,websiteSidebar,workspaceSidebar} from './websites.js';

const standaloneOrigin=()=>websiteOrigin(new URLSearchParams(location.search).get('origin'))||savedWebsite();
// Drawn as soon as the page script runs, before sign-in is known, so the sidebar is in place from the
// start. A signed-out page shows its sign-in panel, and the stylesheet then hides the sidebar.
export function prepareWebsitePage(page){
  const slot=document.querySelector('[data-workspace-sidebar]');
  if(slot?.dataset?.workspaceSidebar===undefined||slot.innerHTML)return;
  slot.innerHTML=page==='connect'?workspaceSidebar({page,external:true}):websiteSidebar({origin:standaloneOrigin(),page,external:true});
}
// Signed-in pages draw the sidebar and account menu at once with what is known, then again when the
// website list arrives, so the layout never jumps. Connect your agent belongs to the whole workspace.
export async function mountWebsitePage({page,request,identity=null,mode={}}){
  const slot=document.querySelector('[data-workspace-sidebar]');
  if(slot?.dataset?.workspaceSidebar===undefined)return null;
  let origin=standaloneOrigin(),websites=[],runs=[],draft='',error='',submitting=false,worker=null,gateway=null;
  const workspacePage=page==='connect',header=document.querySelector('.connection-top .row');
  bindWebsiteFavicons(slot);
  function draw(open=false){
    slot.innerHTML=workspacePage?workspaceSidebar({websites,page,external:true}):websiteSidebar({websites,origin,page,runs:runs.filter(run=>websiteOrigin(run.target_url)===origin),external:true,newUrl:draft,error,submitting});
    const disclosure=slot.querySelector('details');if(disclosure)disclosure.open=open;
  }
  // The account menu holds the theme switch, so it takes the header's theme slot.
  function drawAccount(){
    if(!header)return;const open=!!header.querySelector('.account-menu')?.open;
    header.innerHTML=accountMenuMarkup({name:identity?.workspace_name,development:!!mode.development,browserAuth:!!mode.spekios,worker,gateway,external:true});
    if(open)header.querySelector('.account-menu').open=true;
  }
  draw();drawAccount();
  if(header){
    bindThemeSwitch(header);
    header.addEventListener('change',event=>{if(event.target.id==='notifications-toggle')setNotificationsEnabled(event.target.checked);});
    header.addEventListener('click',event=>{
      if(!event.target.closest?.('[data-action="logout"]'))return;
      clearWebsiteNavigation();
      if(mode.spekios){location.assign('/logout');return;}
      for(const key of ['scout.workspace-token','scout.pending-job','scout.tracked-job'])sessionStorage.removeItem(key);
      location.assign('/');
    });
    document.addEventListener('click',event=>{if(!event.target.closest?.('.account-menu')){const menu=header.querySelector('.account-menu');if(menu)menu.open=false;}});
    document.addEventListener('keydown',event=>{const menu=header.querySelector('.account-menu');if(event.key==='Escape'&&menu?.open){event.preventDefault();menu.open=false;menu.querySelector('summary')?.focus();}});
  }
  const [catalog,jobs,providers]=await Promise.all([request('/v1/runs'),request('/v1/browser-jobs').catch(()=>null),request('/v1/model-providers').catch(()=>null)]);
  websites=groupWebsites(catalog.websites||[],catalog.runs||[]);runs=catalog.runs||[];
  worker=jobs?(jobs.workers||[]).some(w=>w.available):null;gateway=providers?providers.gateway_ready===true:null;
  if(!origin&&!workspacePage)origin=websites[0]?.origin||'';
  if(origin)saveWebsite(origin);if(page==='issues')rememberWebsiteShortcut(origin,'issues');
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
      location.assign(websiteHref(websiteOrigin(target),'overview',true));
    }catch(e){error=e.message;submitting=false;draw(true);slot.querySelector('input')?.focus();}
  });
  document.addEventListener('click',event=>{if(!event.target.closest?.('.website-switcher')){const details=slot.querySelector('details');if(details)details.open=false;}});
  document.addEventListener('keydown',event=>{const details=slot.querySelector('details');if(event.key==='Escape'&&details?.open){event.preventDefault();details.open=false;details.querySelector('summary')?.focus();}});
  draw();drawAccount();
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
