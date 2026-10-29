import { createServer, type Server } from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Page } from 'playwright';
import type { Store } from './store.js';
import { isUuid } from './contracts.js';
import { AuthVault } from './auth-session.js';
import { accessSignals, AccessStopped } from './access-detection.js';

export type AccessResult={context_id:string;session_id:string|null;verification:string}|null;
export type AccessReason='login_required'|'login_available'|'user_requested'|'session_expired';
type Active={id:string;runId:string;page:Page;origin:string;targetUrl:string;mode:string;reason:AccessReason;
  status:'waiting'|'active';lease?:string;client?:string;frame?:string;inputs:Map<string,string>;
  baseline:string;timer:ReturnType<typeof setTimeout>;cleanup?:()=>void;resolve:(result:AccessResult)=>void;reject:(error:Error)=>void};
const same=(a:string,b:string)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};
export function validateHumanInput(value:unknown):Record<string,any>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('invalid_input');
  const v=value as Record<string,any>,fields=v.type==='click'?['input_id','type','frame_id','x','y']:v.type==='text'?['input_id','type','value']:v.type==='key'?['input_id','type','key']:v.type==='scroll'?['input_id','type','direction']:[];
  if(!fields.length||Object.keys(v).some(k=>!fields.includes(k))||!isUuid(v.input_id))throw new Error('invalid_input');
  if(v.type==='click'&&(!isUuid(v.frame_id)||![v.x,v.y].every(n=>Number.isFinite(n)&&n>=0&&n<=4096)))throw new Error('invalid_input');
  if(v.type==='text'&&(typeof v.value!=='string'||!v.value.length||v.value.length>2048||/[\x00-\x1f\x7f]/.test(v.value)))throw new Error('invalid_input');
  if(v.type==='key'&&!['Tab','Shift+Tab','Enter','Backspace','Escape','ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Space'].includes(v.key))throw new Error('invalid_input');
  if(v.type==='scroll'&&!['up','down'].includes(v.direction))throw new Error('invalid_input');
  return v;
}
export class AccessHandoff {
  readonly vault:AuthVault;
  private active?:Active;
  private sequence:Promise<unknown>=Promise.resolve();
  private server?:Server;
  constructor(private store:Store){this.vault=new AuthVault(store);}
  private serial<T>(body:()=>Promise<T>):Promise<T>{const result=this.sequence.then(body);this.sequence=result.catch(()=>{});return result;}
  async listen(port=8083,host='0.0.0.0'){
    const token=process.env.SCOUT_API_TOKEN;if(!token)throw new Error('Private browser control requires workspace authentication.');
    this.server=createServer(async(req,res)=>{
      res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
      if(!same(req.headers.authorization??'','Bearer '+token)){res.writeHead(401);res.end();return;}
      try{
        const match=/^\/(access|sessions)\/([a-f0-9-]{36})\/(start|screen|input|complete|skip|cancel|revoke)$/.exec(req.url??'');
        if(!match||!isUuid(match[2])||(req.method!=='POST'&&!(req.method==='GET'&&match[3]==='screen')))throw new Error('not_found');
        let body=Buffer.alloc(0);for await(const chunk of req){body=Buffer.concat([body,chunk]);if(body.length>8192)throw new Error('invalid_input');}
        const value=body.length?JSON.parse(body.toString()):{};
        const response=await this.serial(async()=>{
          if(match[1]==='sessions'&&match[3]==='revoke'){const row=(await this.store.pool.query('SELECT workspace_id,user_id FROM browser_sessions WHERE session_id=$1',[match[2]])).rows[0];if(!row)throw new Error('not_found');return this.store.withScope({workspaceId:row.workspace_id,userId:row.user_id},()=>this.vault.revoke(match[2])).then(ok=>{if(!ok)throw new Error('not_found');return {revoked:true};});}
          if(match[1]!=='access')throw new Error('not_found');
          return this.control(match[2],match[3],value,String(req.headers['x-scout-access-lease']??''));
        });
        if(Buffer.isBuffer(response)){const a=this.active;if(!a||a.id!==match[2])throw new Error('access_closed');
          res.setHeader('Content-Type','image/png');res.setHeader('X-Scout-Frame-Id',a.frame!);res.end(response);
        }else{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(response));}
      }catch(error){const allowed=['not_found','invalid_input','access_closed','access_claimed','lease_required','stale_frame','outside_app','login_not_complete','not_editable','skip_unavailable'];
        const code=error instanceof Error&&allowed.includes(error.message)?error.message:'private_control_failed';
        res.writeHead(code==='not_found'?404:409,{'Content-Type':'application/json'});res.end(JSON.stringify({error:code}));}
    });
    await new Promise<void>((resolve,reject)=>{this.server!.once('error',reject);this.server!.listen(port,host,()=>resolve());});
    return (this.server.address() as {port:number}).port;
  }
  async close(){
    await this.serial(async()=>{if(this.active)await this.finish('interrupted');});
    await new Promise<void>(resolve=>{if(this.server)this.server.close(()=>resolve());else resolve();});
  }
  async request(page:Page,runId:string,jobId:string|undefined,targetUrl:string,mode:string,reason:AccessReason,timeoutMs=600000,signal?:AbortSignal):Promise<AccessResult>{
    signal?.throwIfAborted();
    if(this.active)throw new Error('Only one private login can run at a time.');
    const id=randomUUID(),origin=new URL(targetUrl).origin;
    const baseline=createHash('sha256').update(JSON.stringify(await page.context().storageState())).digest('hex');
    await this.store.transaction(async()=>{
      await this.store.query(`INSERT INTO browser_access_requests(access_id,run_id,job_id,workspace_id,user_id,origin,reason,status,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,'waiting',now()+($8::int * interval '1 millisecond'))`,[id,runId,jobId??null,this.store.workspaceId,this.store.userId,origin,reason,timeoutMs]);
      await this.store.event(runId,'access.requested',{access_id:id,origin,reason,private_observation:true});
    });
    return new Promise<AccessResult>((resolve,reject)=>{
      const timer=setTimeout(()=>{void this.serial(()=>this.finish('expired')).catch(()=>{});},timeoutMs);
      this.active={id,runId,page,origin,targetUrl,mode,reason,status:'waiting',inputs:new Map(),baseline,timer,resolve,reject};
      const cancel=()=>{void this.serial(async()=>{if(this.active?.id===id)await this.finish('cancelled');}).catch(()=>{});};
      this.active.cleanup=()=>signal?.removeEventListener('abort',cancel);
      signal?.addEventListener('abort',cancel,{once:true});
      if(signal?.aborted)cancel();
    });
  }
  private async finish(status:'completed'|'skipped'|'cancelled'|'expired'|'interrupted',result:AccessResult=null){
    const a=this.active;if(!a)return;
    // Invalidate access before waking the explorer. In-flight input is serialized.
    clearTimeout(a.timer);a.cleanup?.();this.active=undefined;
    try{await this.store.transaction(async()=>{
      await this.store.query('UPDATE browser_access_requests SET status=$2,session_id=$3,verification=$4,finished_at=now() WHERE access_id=$1',
        [a.id,status,result?.session_id??null,result?.verification??null]);
      await this.store.event(a.runId,'access.'+status,{access_id:a.id,context_id:result?.context_id??null,session_id:result?.session_id??null,verification:result?.verification??null,private_observation:true});
    });}catch{a.reject(new Error('Login handoff state could not be saved.'));throw new Error('private_control_failed');}
    if(status==='completed'||status==='skipped')a.resolve(result);else a.reject(new AccessStopped('access_'+status));
  }
  private async control(id:string,action:string,body:Record<string,any>,lease:string):Promise<Buffer|Record<string,unknown>>{
    const a=this.active;if(!a||a.id!==id)throw new Error('access_closed');
    // Use a separate connection: a human request must never join a recorder
    // transaction, and a durable cancellation invalidates the private lease.
    const run=(await this.store.pool.query('SELECT cancel_id FROM runtime_runs WHERE run_id=$1',[a.runId])).rows[0];
    if(!run||run.cancel_id){await this.finish('cancelled');throw new Error('access_closed');}
    if(action==='start'){
      if(Object.keys(body).some(k=>k!=='client_id')||!isUuid(body.client_id))throw new Error('invalid_input');
      if(a.client&&a.client!==body.client_id)throw new Error('access_claimed');
      if(!a.lease){a.lease=randomBytes(32).toString('hex');a.client=body.client_id;a.status='active';
        await this.store.transaction(async()=>{await this.store.query("UPDATE browser_access_requests SET status='active' WHERE access_id=$1",[id]);await this.store.event(a.runId,'access.opened',{access_id:id});});}
      return {lease:a.lease,viewport:a.page.viewportSize(),expires_in_seconds:600};
    }
    if(action==='skip'&&a.status==='waiting'){
      if(a.reason!=='login_available')throw new Error('skip_unavailable');
      await this.finish('skipped');return {status:'skipped'};
    }
    // Cancelling an unclaimed request never gives control to a second browser.
    if(action==='cancel'){await this.finish('cancelled');return {status:'cancelled'};}
    if(!a.lease||!same(lease,a.lease))throw new Error('lease_required');
    if(action==='cancel'){await this.finish('cancelled');return {status:'cancelled'};}
    if(new URL(a.page.url()).origin!==a.origin)throw new Error('outside_app');
    if(action==='screen'){
      const image=await a.page.screenshot({type:'png',fullPage:false,caret:'hide',timeout:5000});
      a.frame=randomUUID();return image; // Transient display only: no spool, bucket, model or event payload.
    }
    if(action==='input'){
      const input=validateHumanInput(body),fingerprint=createHash('sha256').update(JSON.stringify(input)).digest('hex');
      if(a.inputs.has(input.input_id)){if(a.inputs.get(input.input_id)!==fingerprint)throw new Error('invalid_input');return {accepted:true,reused:true};}
      if(a.inputs.size>=1000)throw new Error('invalid_input');
      if(input.type==='click'){
        const size=a.page.viewportSize()!;
        if(input.frame_id!==a.frame)throw new Error('stale_frame');
        if(input.x>=size.width||input.y>=size.height)throw new Error('invalid_input');
      }
      if(input.type==='text'&&!await a.page.evaluate(()=>{
        const e=document.activeElement;return (e instanceof HTMLInputElement&&['text','email','password','tel','number','search'].includes(e.type)&&!e.disabled&&!e.readOnly)||(e instanceof HTMLTextAreaElement&&!e.disabled&&!e.readOnly);
      }))throw new Error('not_editable');
      // Reserve before dispatch. An uncertain response must not type/click twice.
      a.inputs.set(input.input_id,fingerprint);
      await this.store.transaction(()=>this.store.event(a.runId,'access.input',{access_id:id,input_id:input.input_id,kind:input.type,actor:'human',private_payload_omitted:true}));
      if(input.type==='click')await a.page.mouse.click(input.x,input.y);
      if(input.type==='text')await a.page.keyboard.insertText(input.value);
      if(input.type==='key')await a.page.keyboard.press(input.key);
      if(input.type==='scroll')await a.page.mouse.wheel(0,(input.direction==='down'?1:-1)*a.page.viewportSize()!.height*.7);
      a.frame=undefined;return {accepted:true};
    }
    if(action==='complete'){
      if(Object.keys(body).some(k=>k!=='remember')||typeof body.remember!=='boolean')throw new Error('invalid_input');
      if((await accessSignals(a.page)).login_form)throw new Error('login_not_complete');
      // Check the requested entry page again; do not accept a closed popup as proof of access.
      const response=await a.page.goto(a.targetUrl,{waitUntil:'load',timeout:10000});
      if(!response||response.status()>=400||new URL(a.page.url()).origin!==a.origin)throw new Error('login_not_complete');
      const signals=await accessSignals(a.page),current=createHash('sha256').update(JSON.stringify(await a.page.context().storageState())).digest('hex');
      if(signals.login_form||(!signals.signed_in&&current===a.baseline))throw new Error('login_not_complete');
      const verification=signals.signed_in?'entry_page_sign_out_control':'human_confirmed_changed_app_session';
      const contextId=randomUUID();
      const sessionId=body.remember?await this.vault.save(a.page.context(),{session_id:contextId,origin:a.origin,execution_mode:a.mode},a.runId,verification):null;
      await this.finish('completed',{context_id:contextId,session_id:sessionId,verification});
      return {status:'completed',session_id:sessionId,verification};
    }
    throw new Error('invalid_input');
  }
}
