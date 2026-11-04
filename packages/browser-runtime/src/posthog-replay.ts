import type { Browser, Page } from 'playwright';
import type { FlowStep } from './posthog-flows.js';
import { safeSelector } from './posthog-flows.js';

export type ReplayResult = { status:'completed'|'blocked'|'failed'|'interrupted'; outcome:'matched_observations'|'steps_executed'|'incomplete'; steps: {index:number;action:string;status:string;path?:string}[]; error?:string };
// The caller admits only operator-allowlisted, resettable origins. No session,
// credential, script, selector expression or network destination is imported.
export async function replayFlow(browser:Browser,origin:string,steps:FlowStep[],active:()=>Promise<boolean>=async()=>true,signal:AbortSignal=AbortSignal.timeout(120000)):Promise<ReplayResult> {
  const results:ReplayResult['steps']=[];
  if(!steps.length||steps.length>40||steps[0].action!=='navigate')return {status:'blocked',outcome:'incomplete',steps:results,error:'unsupported_workflow'};
  const context=await browser.newContext({viewport:{width:1280,height:800},serviceWorkers:'block',acceptDownloads:false});
  let page:Page|undefined;
  const stop=()=>{void context.close().catch(()=>{});};signal.addEventListener('abort',stop,{once:true});
  try{
    await context.addInitScript('globalThis.__SPEKIOS_REPLAY__ = true;');
    await context.route('**/*',async route=>{
      const url=new URL(route.request().url());
      if(url.origin!==origin||url.username||url.password)return route.abort('blockedbyclient');
      return route.continue();
    });
    await context.routeWebSocket('**/*',ws=>ws.close());
    page=await context.newPage();page.setDefaultTimeout(5000);page.setDefaultNavigationTimeout(10000);
    page.on('popup',popup=>void popup.close());page.on('dialog',dialog=>void dialog.dismiss());
    for(let index=0;index<steps.length;index++){
      signal.throwIfAborted();
      if(!await active())return {status:'interrupted',outcome:'incomplete',steps:results,error:'connection_paused_or_removed'};
      const step=steps[index];
      if(step.action==='navigate'){
        const url=new URL(step.path??'',origin);
        if(!step.path?.startsWith('/')||url.origin!==origin||url.search||url.hash||url.username||url.password)throw new Error('unsupported_navigation');
        // A click may already have navigated an SPA. Reloading that page would
        // erase the application's cart or other in-memory state.
        if(page.url()!==url.href){
          const response=await page.goto(url.href,{waitUntil:'domcontentloaded'});
          if(!response||response.status()>=400)throw new Error('navigation_failed');
        }
      }else{
        if(!safeSelector(step.selector))throw new Error('unsupported_selector');
        const target=page.locator(step.selector);
        if(await target.count()!==1)throw new Error('selector_missing_or_ambiguous');
        if(step.action==='observe'){
          const expected=step.value;
          if(typeof expected!=='string'||expected.length>300)throw new Error('observation_missing');
          await target.waitFor({state:'visible'});
          // A recorded observation is an inferred expectation, not a product requirement.
          const until=Date.now()+5000;
          while((await target.innerText()).replace(/\s+/g,' ').trim()!==expected.replace(/\s+/g,' ').trim()){
            if(Date.now()>until)throw new Error('recorded_observation_mismatch');
            signal.throwIfAborted();await new Promise(resolve=>setTimeout(resolve,100));
          }
        }else if(step.action==='click')await target.click();
        else if(step.action==='fill'&&typeof step.value==='string')await target.fill(step.value);
        else if(step.action==='select'&&typeof step.value==='string')await target.selectOption(step.value);
        else if(step.action==='check'&&typeof step.checked==='boolean')await target.setChecked(step.checked);
        else throw new Error('unsupported_interaction');
      }
      if(new URL(page.url()).origin!==origin)throw new Error('navigation_left_source');
      results.push({index,action:step.action,status:'completed',path:new URL(page.url()).pathname});
    }
    return {status:'completed',outcome:steps.some(s=>s.action==='observe')?'matched_observations':'steps_executed',steps:results};
  }catch(error){
    const message=error instanceof Error?error.message:'';
    const known=['unsupported_navigation','navigation_failed','unsupported_selector','selector_missing_or_ambiguous','observation_missing','recorded_observation_mismatch','unsupported_interaction','navigation_left_source'];
    return {status:signal.aborted?'interrupted':'failed',outcome:'incomplete',steps:results,error:known.includes(message)?message:signal.aborted?'replay_time_limit':'browser_interaction_failed'};
  }finally{signal.removeEventListener('abort',stop);await context.close().catch(()=>{});}
}
