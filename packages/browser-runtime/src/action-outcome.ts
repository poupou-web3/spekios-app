import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Page, Request, Response, ConsoleMessage } from 'playwright';
import { hash, jsonBytes, type Store } from './store.js';
import { image, type Hooks } from './recorder.js';
import { PrivateLoginSurface } from './access-detection.js';
import { RunCancelled } from './run-control.js';

export const COMPLETION_VERSION = 'action-completion-v1';
export const COMPLETION_LIMITS = { timeout_ms: 5000, minimum_ms: 1000, quiet_ms: 600, sample_interval_ms: 200, max_frames: 24, long_lived_request_ms: 2000 };
type Artifact = Awaited<ReturnType<Store['artifact']>>;
type Event = { event_id:string; kind:string; offset_ms:number; [key:string]:unknown };
export type Completion = { version:string; status:'settled'|'timed_out'|'observation_failed'; elapsed_ms:number;
  limits:typeof COMPLETION_LIMITS; samples:number; observation_failures:number; visual_changes:number; dom_changes:number; url_changes:number;
  pending_requests:number; busy:boolean; reason:string; frames:{frame_id:string;observed_at:string;offset_ms:number;sha256:string;artifact:Artifact}[] };
export function incompleteCompletion(reason:string):Completion {
  return {version:COMPLETION_VERSION,status:'observation_failed',elapsed_ms:0,limits:{...COMPLETION_LIMITS},samples:0,observation_failures:0,
    visual_changes:0,dom_changes:0,url_changes:0,pending_requests:0,busy:false,reason,frames:[]};
}
async function boundedRead<T>(read:Promise<T>,milliseconds:number):Promise<T> {
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([read,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Observation deadline')),milliseconds);})]);}
  finally{clearTimeout(timer);}
}

export function diagnosticUrl(raw:string) {
  try { const url=new URL(raw); return url.origin+url.pathname.replace(/[a-zA-Z0-9_-]{32,}/g,'[redacted]').slice(0,240); }
  catch { return '[unavailable URL]'; }
}
export function diagnosticText(text:string) {
  return text.replace(/https?:\/\/[^\s"'<>]+/g,diagnosticUrl)
    .replace(/\b(bearer\s+)[\w.\-]+/gi,'$1[redacted]')
    .replace(/\b(password|secret|token|authorization|cookie|api[_ -]?key)\s*[:=]\s*[^\s,;]+/gi,'$1=[redacted]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[redacted email]')
    .replace(/[a-zA-Z0-9_-]{40,}/g,'[redacted]').slice(0,500);
}

// Listeners belong to one dispatched action, and are detached before a private
// handoff or the next model call. No headers, cookies, bodies, console arguments
// or stack traces are collected. Request IDs join start/response/finish events.
export class ActionDiagnostics {
  readonly started=performance.now();
  readonly events:Event[]=[];
  readonly pending=new Map<Request,{id:string;started:number}>();
  lastActivity=this.started;
  dropped=0;
  private detached=false;
  constructor(private page:Page) {
    page.on('request',this.request); page.on('response',this.response);
    page.on('requestfinished',this.finished); page.on('requestfailed',this.failed);
    page.on('console',this.console); page.on('pageerror',this.pageError);
  }
  private push(kind:string,fields:Record<string,unknown>) {
    if(this.detached)return;
    if(this.events.length>=100){this.dropped++;return;}
    this.events.push({event_id:randomUUID(),kind,offset_ms:Math.round(performance.now()-this.started),...fields});
  }
  private request=(request:Request)=>{
    this.lastActivity=performance.now();
    if(this.pending.size>=1000){this.dropped++;return;}
    const record={id:randomUUID(),started:this.lastActivity};this.pending.set(request,record);
    this.push('request',{request_id:record.id,url:diagnosticUrl(request.url()),method:request.method(),resource_type:request.resourceType()});
  };
  private response=(response:Response)=>{
    const record=this.pending.get(response.request());if(!record)return;
    this.lastActivity=performance.now();
    this.push('response',{request_id:record.id,url:diagnosticUrl(response.url()),status:response.status()});
  };
  private end(request:Request,error?:string) {
    const record=this.pending.get(request);if(!record)return;
    this.pending.delete(request);
    const policy=!!error&&error.includes('ERR_BLOCKED_BY_CLIENT');
    const now=performance.now();
    if(!policy)this.lastActivity=now;
    this.push(error?'request_failed':'request_finished',{request_id:record.id,duration_ms:Math.round(now-record.started),...(error?{error:diagnosticText(error),...(policy?{blocked_by_runtime:true}:{})}:{})});
  }
  private finished=(request:Request)=>this.end(request);
  private failed=(request:Request)=>this.end(request,request.failure()?.errorText??'request failed');
  private console=(message:ConsoleMessage)=>{
    if(!['error','warning','warn'].includes(message.type()))return;
    const text=diagnosticText(message.text());
    if(text.includes('ERR_BLOCKED_BY_CLIENT'))return;
    this.push('console',{level:message.type(),text});
  };
  private pageError=(error:Error)=>this.push('page_error',{text:diagnosticText(error.message)});
  blockingPending(now=performance.now()) {
    let blocking=0;
    for(const record of this.pending.values()) if(now-record.started<COMPLETION_LIMITS.long_lived_request_ms) blocking++;
    return blocking;
  }
  stop() {
    this.page.off('request',this.request);this.page.off('response',this.response);
    this.page.off('requestfinished',this.finished);this.page.off('requestfailed',this.failed);
    this.page.off('console',this.console);this.page.off('pageerror',this.pageError);this.detached=true;
  }
  snapshot() {
    return {version:COMPLETION_VERSION,scope:'dispatch_through_after_capture',events:this.events,dropped_events:this.dropped,
      pending_requests:this.pending.size,blocking_requests:this.blockingPending(),redaction:'no_headers_bodies_cookies_args_or_stacks; URL_queries_fragments_and_common_secret_patterns_removed',
      http_errors:this.events.filter(e=>e.kind==='response'&&Number(e.status)>=400).length,
      request_failures:this.events.filter(e=>e.kind==='request_failed'&&!e.blocked_by_runtime).length,
      runtime_blocks:this.events.filter(e=>e.blocked_by_runtime).length,
      console_errors:this.events.filter(e=>e.kind==='page_error'||e.kind==='console'&&e.level==='error').length};
  }
}

function observationBoundary(error:unknown) {
  return error instanceof PrivateLoginSurface||error instanceof RunCancelled||(error instanceof Error&&error.name==='AbortError');
}

// Stability is bounded evidence, not proof the app has no future work. Exact
// pixels are retained; continuous animation reaches the deadline instead of
// spawning an unbounded sequence of exploration nodes. A screenshot uses the
// time left in the window: a one-second cap turns a slow readback into zero
// frames. A connection open for long_lived_request_ms is a background channel.
export async function settleAction(store:Store,page:Page,runId:string,actionId:string,diagnostics:ActionDiagnostics,hooks:Hooks):Promise<Completion> {
  const started=performance.now(),limits={...COMPLETION_LIMITS};
  let lastVisual:string|undefined,lastDom:string|undefined,lastUrl:string|undefined,quietSince=started;
  const result:Completion={version:COMPLETION_VERSION,status:'timed_out',elapsed_ms:0,limits,samples:0,observation_failures:0,visual_changes:0,dom_changes:0,url_changes:0,
    pending_requests:0,busy:false,reason:'The page did not reach a quiet observation within the bounded wait.',frames:[]};
  const budget=()=>Math.max(1,limits.timeout_ms-(performance.now()-started));
  const noteFailure=()=>{
    result.observation_failures++;
    result.status=result.samples?'timed_out':'observation_failed';
    result.reason=result.samples?'The page did not reach a quiet observation within the bounded wait.':'No complete observation was available.';
    quietSince=performance.now();
  };
  const pause=()=>new Promise(resolve=>setTimeout(resolve,Math.min(limits.sample_interval_ms,Math.max(0,limits.timeout_ms-(performance.now()-started)))));
  const readDom=()=>boundedRead(page.evaluate(()=>({url:location.href,busy:document.readyState==='loading'||Array.from(document.querySelectorAll('[aria-busy="true"],[role="progressbar"]')).some(node=>{
    const rect=node.getBoundingClientRect(),style=getComputedStyle(node);return !!(rect.width&&rect.height)&&style.visibility==='visible'&&style.display!=='none';
  }),signature:JSON.stringify([document.title,document.body?.innerText?.slice(0,12000),scrollX,scrollY,
    Array.from(document.querySelectorAll('input,select,textarea,button,a[href],[role="status"],[role="alert"]')).slice(0,200).map(node=>{
      const field=node as HTMLInputElement;return [node.tagName,node.textContent?.slice(0,200),field.type==='password'?'[private]':field.value?.slice(0,500),field.checked,field.disabled,node.getAttribute('aria-expanded'),node.getAttribute('aria-invalid')];
    })])})),Math.min(1000,budget()));
  while(performance.now()-started<limits.timeout_ms&&result.samples<limits.max_frames) {
    try{await hooks.beforeCapture?.(page);}
    catch(error){
      if(observationBoundary(error))throw error;
      noteFailure();await pause();continue;
    }
    let dom:{url:string;signature:string;busy:boolean}|undefined,bytes:Buffer|undefined;
    try{dom=await readDom();}catch(error){if(observationBoundary(error))throw error;}
    if(performance.now()-started<limits.timeout_ms){
      try{bytes=await image(page,budget());}
      catch(error){if(observationBoundary(error))throw error;}
    }
    if(bytes&&!dom&&performance.now()-started<limits.timeout_ms){
      try{dom=await readDom();}catch(error){if(observationBoundary(error))throw error;}
    }
    if(!dom||!bytes){
      // Navigation can replace the execution context between samples. A later
      // complete sample may settle; no failed sample supports a verdict.
      noteFailure();await pause();continue;
    }
    // Never persist a frame or diagnostic payload after entering private login.
    try{await hooks.beforeCapture?.(page);}
    catch(error){
      if(observationBoundary(error))throw error;
      noteFailure();await pause();continue;
    }
    const now=performance.now(),visual=hash(bytes),domHash=hash(Buffer.from(dom.signature));
    if(lastVisual&&visual!==lastVisual){result.visual_changes++;quietSince=now;}
    if(lastDom&&domHash!==lastDom){result.dom_changes++;quietSince=now;}
    if(lastUrl&&dom.url!==lastUrl){result.url_changes++;quietSince=now;}
    if(dom.busy||diagnostics.blockingPending())quietSince=now;
    lastVisual=visual;lastDom=domHash;lastUrl=dom.url;result.busy=dom.busy;result.samples++;
    const frame={frame_id:randomUUID(),observed_at:new Date().toISOString(),offset_ms:Math.round(now-diagnostics.started),sha256:visual,
      artifact:await store.artifact(runId,'settling_frame',bytes,'png')};
    result.frames.push(frame);
    // Persist references as we go: a crash must not orphan sampled frames from
    // their originating action. These events also flow to ClickHouse.
    await store.transaction(()=>store.event(runId,'action.settling_frame',frame,actionId));
    if(now-started>=limits.minimum_ms&&now-Math.max(quietSince,diagnostics.lastActivity)>=limits.quiet_ms&&!dom.busy&&!diagnostics.blockingPending()) {
      result.status='settled';result.reason='Pixels, observed DOM, URL and tracked requests were quiet within the bounded observation window.';break;
    }
    result.status='timed_out';
    await pause();
  }
  result.elapsed_ms=Math.round(performance.now()-started);result.pending_requests=diagnostics.blockingPending();
  return result;
}

export async function saveOutcome(store:Store,runId:string,actionId:string,completion:Completion,diagnostics:ActionDiagnostics) {
  diagnostics.stop();
  const network=diagnostics.snapshot();
  const diagnosticArtifact=await store.artifact(runId,'action_diagnostics',jsonBytes({action_id:actionId,...network}),'json');
  const completionArtifact=await store.artifact(runId,'action_completion',jsonBytes({action_id:actionId,...completion}),'json');
  const {frames:_,...summary}=completion;
  const outcome={...summary,completion_artifact:completionArtifact,diagnostics_artifact:diagnosticArtifact,
    diagnostics:{http_errors:network.http_errors,request_failures:network.request_failures,runtime_blocks:network.runtime_blocks,console_errors:network.console_errors,dropped_events:network.dropped_events},
    diagnostic_events:network.events};
  await store.transaction(async()=>{
    await store.query('UPDATE runtime_actions SET outcome=$2 WHERE action_id=$1',[actionId,JSON.stringify(outcome)]);
    await store.event(runId,'action.outcome_recorded',outcome,actionId);
  });
  return outcome;
}

export function outcomeContext(outcome:Awaited<ReturnType<typeof saveOutcome>>) {
  const evidence=outcome.diagnostic_events.filter(e=>e.kind==='page_error'||e.kind==='console'||e.kind==='request_failed'||e.kind==='response'&&Number(e.status)>=400);
  return {status:outcome.status,elapsed_ms:outcome.elapsed_ms,reason:outcome.reason,pending_requests:outcome.pending_requests,busy:outcome.busy,
    ...outcome.diagnostics,events:[...evidence.filter(e=>!e.blocked_by_runtime),...evidence.filter(e=>e.blocked_by_runtime)].slice(0,8),
    diagnostics_artifact_id:outcome.diagnostics_artifact.artifact_id,completion_artifact_id:outcome.completion_artifact.artifact_id};
}
