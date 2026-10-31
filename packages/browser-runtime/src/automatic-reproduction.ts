import { randomUUID } from 'node:crypto';
import type { Store } from './store.js';

import { publicHttpsOrigin } from './exploration-policy.js';
import { loadReplay } from './reproduction.js';
import { COMPLETION_VERSION } from './action-outcome.js';
import { MAX_EXPLORATION_ACTIONS, MAX_REPLAY_ORDINAL } from './contracts.js';

// Total replay actions across one exploration's automatic checks, counting
// every prerequisite step. One full-length path fits twice.
export const MAX_AUTO_REPLAY_ACTIONS = MAX_EXPLORATION_ACTIONS * 2;

export type AutomaticReproductionPolicy = { enabled:boolean; max_cases:number; max_actions:number };
export type GatewayStatus = { executionMode:'live'|'protocol_fixture'; configuredProviders:string[] };
export function automaticReproductionPolicy(options:{autoReproduce?:boolean;maxAutoReproductions?:number;maxAutoReplayActions?:number}={}):AutomaticReproductionPolicy {
  const maxCases=options.maxAutoReproductions??2,maxActions=options.maxAutoReplayActions??12;
  if(typeof (options.autoReproduce??false)!=='boolean'||!Number.isInteger(maxCases)||maxCases<1||maxCases>3||!Number.isInteger(maxActions)||maxActions<1||maxActions>MAX_AUTO_REPLAY_ACTIONS)
    throw new Error(`Automatic reproduction requires a boolean opt-in, 1–3 cases and 1–${MAX_AUTO_REPLAY_ACTIONS} total replay actions.`);
  return {enabled:options.autoReproduce===true,max_cases:maxCases,max_actions:maxActions};
}
export function automaticReservation(policy:AutomaticReproductionPolicy,reservedCases:number,reservedActions:number,pathActions:number) {
  if(reservedCases>=policy.max_cases)return 'case_limit';
  if(reservedActions+pathActions>policy.max_actions)return 'action_limit';
  return null;
}
const origins=()=> (process.env.SCOUT_ALLOWED_ORIGINS??'http://exploration-fixture:8082').split(',').map(s=>s.trim());
export function transientEvidenceFailure(error:unknown):boolean {
  const failure=error as {name?:string;code?:string;cause?:{code?:string};$metadata?:unknown;message?:string};
  return !!failure&&(!!failure.$metadata||['TimeoutError','AbortError','NoSuchKey','NotFound','ServiceUnavailable','InternalError','NetworkingError','RequestTimeout','CredentialsProviderError'].includes(failure.name??'')||
    ['ENOTFOUND','ECONNRESET','ECONNREFUSED','ETIMEDOUT','EHOSTUNREACH','ENETUNREACH','EPIPE'].includes(failure.code??failure.cause?.code??'')||failure.name==='TypeError'&&failure.message==='fetch failed');
}
const providerAvailable=(source:any,gateway:GatewayStatus|null)=> !!gateway&&source.execution_mode===gateway.executionMode&&gateway.configuredProviders.includes(source.settings?.provider);

/** Decisions and queue admissions share the API admission lock, followed by
 * parent job, source run and task row locks. Browser jobs can run alongside it. */
export class AutomaticReproductionScheduler {
  constructor(private store:Store){}
  private async source(sourceRunId:string) {
    return (await this.store.query(`SELECT r.*,j.job_id AS source_job_id,j.request,j.settings,j.execution_mode,j.status AS job_status,
      j.cancel_id AS job_cancel_id,j.agent_id,j.project_id,j.task_id FROM runtime_runs r JOIN browser_jobs j ON j.run_id=r.run_id
      WHERE r.run_id=$1 AND r.workspace_id=$2 AND r.user_id=$3 AND j.parent_job_id IS NULL`,[sourceRunId,this.store.workspaceId,this.store.userId])).rows[0];
  }
  private enabled(source:any) {
    return source&&source.lifecycle==='completed'&&source.job_status==='completed'&&!source.cancel_id&&!source.job_cancel_id&&!source.auto_reproduction_cancel_id&&
      source.request?.kind==='explore'&&source.settings?.autoReproduce===true&&source.config?.runtime_version==='explorer-v1'&&!source.config.replay_of&&source.config.automatic_reproduction_policy?.enabled===true;
  }
  private async lockedSource(sourceRunId:string,sourceJobId:string) {
    await this.store.query('SELECT pg_advisory_xact_lock(736268194002)');
    await this.store.query('SELECT job_id FROM browser_jobs WHERE job_id=$1 FOR UPDATE',[sourceJobId]);
    await this.store.query('SELECT run_id FROM runtime_runs WHERE run_id=$1 FOR UPDATE',[sourceRunId]);
    return this.source(sourceRunId);
  }
  private async decision(task:any,status:'pending'|'queued'|'skipped',reason:string,childJobId:string|null=task.child_job_id??null) {
    if(task.status===status&&task.reason===reason&&task.child_job_id===childJobId)return false;
    await this.store.query('UPDATE automatic_reproduction_tasks SET status=$2,reason=$3,child_job_id=$4,updated_at=now() WHERE task_id=$1',[task.task_id,status,reason,childJobId]);
    await this.store.event(task.source_run_id,'auto_reproduction.'+status,{task_id:task.task_id,source_action_id:task.source_action_id,reason,planned_actions:task.planned_actions,child_job_id:childJobId},task.source_action_id);
    return true;
  }
  private async existingAttempt(sourceActionId:string,ignoreJobId?:string) {
    return !!(await this.store.query(`SELECT 1 WHERE EXISTS(SELECT 1 FROM runtime_reproductions WHERE source_action_id=$1)
      OR EXISTS(SELECT 1 FROM browser_jobs WHERE workspace_id=$2 AND user_id=$3 AND request->>'kind'='reproduce'
        AND request->>'source_action_id'=$1::text AND ($4::uuid IS NULL OR job_id<>$4))`,[sourceActionId,this.store.workspaceId,this.store.userId,ignoreJobId??null])).rowCount;
  }
  private async preflight(source:any,sourceActionId:string,ignoreJobId?:string):Promise<{reason:string|null;actions:number}> {
    if(!this.enabled(source))return {reason:'source_unavailable',actions:0};
    const disposition=(await this.store.query('SELECT disposition FROM finding_reviews WHERE action_id=$1 ORDER BY revision DESC LIMIT 1',[sourceActionId])).rows[0]?.disposition;
    if(disposition==='confirmed'||disposition==='dismissed')return {reason:'reviewed',actions:0};
    if(await this.existingAttempt(sourceActionId,ignoreJobId))return {reason:'existing_attempt',actions:0};
    let origin:string;
    try {origin=new URL(source.target_url).origin;}catch{return {reason:'scope_unavailable',actions:0};}
    if(!Array.isArray(source.settings?.allowedOrigins))return {reason:'scope_unavailable',actions:0};
    let permitted=false;try{permitted=publicHttpsOrigin(new URL(origin))||(source.settings.allowedOrigins.includes(origin)&&origins().includes(origin));}catch{permitted=false;}
    if(!permitted)return {reason:'scope_unavailable',actions:0};
    const target=(await this.store.query('SELECT * FROM runtime_actions WHERE action_id=$1 AND run_id=$2',[sourceActionId,source.run_id])).rows[0];
    if(!target||target.state!=='completed'||target.assessment?.verdict!=='suspect'||target.assessment.expectation_uncertain||target.tool_error)
      return {reason:'ineligible_assessment',actions:0};
    // Count and validate the saved database prefix before touching the bucket.
    // A readback outage may reserve this bounded path, but can never dispatch it.
    const authContext=target.spec?.auth_context_id?(source.config.auth_contexts??[]).find((c:any)=>c.context_id===target.spec.auth_context_id):null;
    if(target.spec?.auth_context_id&&!authContext?.session_id)return {reason:'session_unavailable',actions:0};
    const prefix=(await this.store.query('SELECT * FROM runtime_actions WHERE run_id=$1 AND ordinal<=$2 ORDER BY ordinal',[source.run_id,target.ordinal])).rows;
    const path=authContext?prefix.filter(a=>a.spec?.auth_context_id===authContext.context_id):prefix;
    const firstOrdinal=path[0]?.ordinal??1;
    if(target.ordinal<1||target.ordinal>MAX_REPLAY_ORDINAL||path.length!==target.ordinal-firstOrdinal+1||path.some((a,i)=>a.ordinal!==firstOrdinal+i))return {reason:'invalid_path',actions:0};
    const rows=path.filter(a=>!(a.state==='skipped'&&!a.dispatched_at&&a.before_capture_id&&!a.after_capture_id));
    if(!rows.length||rows.length>MAX_EXPLORATION_ACTIONS||rows.at(-1)?.action_id!==sourceActionId||rows[0].spec?.command?.type!=='navigate'||rows[0].spec.command.url!==source.target_url)return {reason:'invalid_path',actions:0};
    if(rows.some(a=>a.state!=='completed'||a.tool_error||a.assessment?.expectation_uncertain||a.outcome?.version!==COMPLETION_VERSION||a.outcome?.status!=='settled'||
      !a.comparison||!a.before_capture_id||!a.after_capture_id||a.spec?.prediction?.source!=='model'||typeof a.spec.prediction.expected_result!=='string'||!a.spec.prediction.expected_result.trim()||
      (a.action_id!==sourceActionId&&a.assessment?.verdict!=='no_issue_observed')))return {reason:'incomplete_path',actions:0};
    if(authContext){
      const sessionId=authContext.session_id;
      if(!sessionId||!(await this.store.query(`SELECT 1 FROM browser_sessions WHERE session_id=$1 AND workspace_id=$2 AND user_id=$3
        AND origin=$4 AND execution_mode=$5 AND revoked_at IS NULL AND expires_at>now()`,[sessionId,this.store.workspaceId,this.store.userId,origin,source.execution_mode])).rowCount)
        return {reason:'session_unavailable',actions:0};
    }
    // Replay loads immutable metadata and verifies every screenshot checksum. It
    // does not launch a browser, call a provider or allocate a reproduction.
    try {
      const replay=await loadReplay(this.store,sourceActionId);
      if(replay.steps.length!==rows.length)return {reason:'invalid_path',actions:0};
    }catch(error){return transientEvidenceFailure(error)?{reason:'evidence_unavailable',actions:rows.length}:{reason:'invalid_path',actions:0};}
    return {reason:null,actions:rows.length};
  }
  async planOne(gateway:GatewayStatus|null) {
    const source=(await this.store.query(`SELECT r.run_id FROM runtime_runs r JOIN browser_jobs j ON j.run_id=r.run_id
      WHERE r.workspace_id=$1 AND r.user_id=$2 AND r.lifecycle='completed' AND j.status='completed' AND j.parent_job_id IS NULL
        AND r.auto_reproduction_planned_at IS NULL AND r.auto_reproduction_cancel_id IS NULL AND r.cancel_id IS NULL AND j.cancel_id IS NULL
        AND j.request->>'kind'='explore' AND j.settings->'autoReproduce'='true'::jsonb
        AND r.config->>'runtime_version'='explorer-v1' AND r.config->'replay_of'='null'::jsonb
        AND r.config->'automatic_reproduction_policy'->'enabled'='true'::jsonb
      ORDER BY j.finished_at,j.job_id LIMIT 1`,[this.store.workspaceId,this.store.userId])).rows[0];
    if(!source)return;
    const original=await this.source(source.run_id);
    if(!this.enabled(original))return;
    const policy=automaticReproductionPolicy({autoReproduce:true,maxAutoReproductions:original.config.automatic_reproduction_policy.max_cases,maxAutoReplayActions:original.config.automatic_reproduction_policy.max_actions});
    const suspects=(await this.store.query("SELECT action_id FROM runtime_actions WHERE run_id=$1 AND assessment->>'verdict'='suspect' ORDER BY ordinal",[source.run_id])).rows;
    const plans:{actionId:string;reason:string|null;actions:number}[]=[];let reservedCases=0,reservedActions=0;
    for(const suspect of suspects){
      const check=await this.preflight(original,suspect.action_id);
      const deferred=check.reason==='evidence_unavailable';
      const reason=(deferred?null:check.reason)??automaticReservation(policy,reservedCases,reservedActions,check.actions);
      if(!reason){reservedCases++;reservedActions+=check.actions;}
      plans.push({actionId:suspect.action_id,reason:reason??(deferred?'evidence_unavailable':null),actions:reason?0:check.actions});
    }
    await this.store.transaction(async()=>{
      const current=await this.lockedSource(source.run_id,original.source_job_id);
      if(!this.enabled(current)||current.auto_reproduction_planned_at)return;
      await this.store.query('UPDATE runtime_runs SET auto_reproduction_planned_at=now() WHERE run_id=$1',[source.run_id]);
      await this.store.event(source.run_id,'auto_reproduction.planned',{policy,reserved_cases:reservedCases,reserved_actions:reservedActions,candidates:plans.length});
      for(const plan of plans){
        const taskId=randomUUID(),reason=plan.reason??(providerAvailable(current,gateway)?'awaiting_queue':'provider_unavailable'),status=plan.reason&&plan.reason!=='evidence_unavailable'?'skipped':'pending';
        const inserted=await this.store.query(`INSERT INTO automatic_reproduction_tasks(task_id,source_run_id,source_job_id,source_action_id,status,reason,planned_actions)
          VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(source_action_id) DO NOTHING RETURNING task_id`,[taskId,source.run_id,original.source_job_id,plan.actionId,status,reason,plan.actions]);
        if(inserted.rowCount)await this.store.event(source.run_id,'auto_reproduction.'+status,{task_id:taskId,source_action_id:plan.actionId,reason,planned_actions:plan.actions,child_job_id:null},plan.actionId);
      }
    });
  }
  async enqueuePending(gateway:GatewayStatus|null) {
    const pending=(await this.store.query(`SELECT t.* FROM automatic_reproduction_tasks t JOIN runtime_runs r ON r.run_id=t.source_run_id JOIN browser_jobs p ON p.job_id=t.source_job_id
      WHERE t.status='pending' AND r.workspace_id=$1 AND r.user_id=$2
      ORDER BY CASE WHEN p.execution_mode=$3 AND p.settings->>'provider'=ANY($4::text[]) THEN 0 ELSE 1 END,t.updated_at,t.task_id LIMIT 3`,[this.store.workspaceId,this.store.userId,gateway?.executionMode??null,gateway?.configuredProviders??[]])).rows;
    for(const task of pending){
      const source=await this.source(task.source_run_id);
      const preflight=await this.preflight(source,task.source_action_id);
      await this.store.transaction(async()=>{
        const current=await this.lockedSource(task.source_run_id,task.source_job_id);
        const locked=(await this.store.query('SELECT * FROM automatic_reproduction_tasks WHERE task_id=$1 FOR UPDATE',[task.task_id])).rows[0];
        if(!locked||locked.status!=='pending')return;
        let reason=preflight.reason;
        if(!this.enabled(current))reason='source_unavailable';
        // Reviews and manual admissions can race with the immutable preflight.
        const review=(await this.store.query('SELECT disposition FROM finding_reviews WHERE action_id=$1 ORDER BY revision DESC LIMIT 1',[task.source_action_id])).rows[0]?.disposition;
        if(review==='confirmed'||review==='dismissed')reason='reviewed';
        if(await this.existingAttempt(task.source_action_id))reason='existing_attempt';
        if(reason==='evidence_unavailable'){await this.decision(locked,'pending',reason);return;}
        if(reason){await this.decision(locked,'skipped',reason);return;}
        if(!providerAvailable(current,gateway)){await this.decision(locked,'pending','provider_unavailable');return;}
        const queued=Number((await this.store.query("SELECT count(*) FROM browser_jobs WHERE workspace_id=$1 AND status IN ('queued','running')",[this.store.workspaceId])).rows[0].count);
        if(queued>=10){await this.decision(locked,'pending','queue_capacity');return;}
        const childId=randomUUID(),request={kind:'reproduce',source_action_id:task.source_action_id};
        const settings={...current.settings,autoReproduce:false};
        await this.store.query(`INSERT INTO browser_jobs(job_id,workspace_id,user_id,request,settings,execution_mode,status,parent_job_id,automatic_source_action_id,agent_id,project_id,task_id)
          VALUES($1,$2,$3,$4,$5,$6,'queued',$7,$8,$9,$10,$11)`,[childId,this.store.workspaceId,this.store.userId,JSON.stringify(request),JSON.stringify(settings),current.execution_mode,task.source_job_id,task.source_action_id,current.agent_id??null,current.project_id??null,current.task_id??null]);
        await this.decision(locked,'queued','scheduled',childId);
      });
    }
  }
  async sweep(gateway:GatewayStatus|null){await this.planOne(gateway);await this.enqueuePending(gateway);}
  /** Last fence before a claimed automatic child can allocate a run or pay for
   * inference. Manual reproduction jobs are unaffected by batch cancellation. */
  async beforeDispatch(job:any,gateway:GatewayStatus|null) {
    if(!job.automatic_source_action_id)return true;
    const task=(await this.store.query('SELECT * FROM automatic_reproduction_tasks WHERE child_job_id=$1',[job.job_id])).rows[0];
    if(!task){
      await this.store.query("UPDATE browser_jobs SET status='cancelled',cancel_id=COALESCE(cancel_id,$2),cancel_requested_at=COALESCE(cancel_requested_at,now()),finished_at=now(),error='Automatic reproduction reservation is unavailable.' WHERE job_id=$1",[job.job_id,randomUUID()]);
      return false;
    }
    const source=await this.source(task.source_run_id),check=await this.preflight(source,task.source_action_id,job.job_id);
    let allowed=false;
    await this.store.transaction(async()=>{
      const current=await this.lockedSource(task.source_run_id,task.source_job_id);
      const locked=(await this.store.query('SELECT * FROM automatic_reproduction_tasks WHERE task_id=$1 FOR UPDATE',[task.task_id])).rows[0];
      const child=(await this.store.query('SELECT cancel_id,status FROM browser_jobs WHERE job_id=$1 FOR UPDATE',[job.job_id])).rows[0];
      let reason=check.reason;
      if(!this.enabled(current)||locked.status!=='queued'||child.cancel_id||child.status!=='running')reason='source_unavailable';
      const review=(await this.store.query('SELECT disposition FROM finding_reviews WHERE action_id=$1 ORDER BY revision DESC LIMIT 1',[task.source_action_id])).rows[0]?.disposition;
      if(review==='confirmed'||review==='dismissed')reason='reviewed';
      if(await this.existingAttempt(task.source_action_id,job.job_id))reason='existing_attempt';
      if(reason==='evidence_unavailable'){
        await this.decision(locked,'queued',reason);
        await this.store.query("UPDATE browser_jobs SET status='queued',worker_id=NULL,started_at=NULL,next_attempt_at=now()+interval '5 seconds' WHERE job_id=$1",[job.job_id]);return;
      }
      if(!reason&&!providerAvailable(current,gateway)){
        // No dispatch took place. Keep the already admitted child queued until
        // its frozen provider is available, preserving its stable job ID.
        await this.decision(locked,'queued','provider_unavailable');
        await this.store.query("UPDATE browser_jobs SET status='queued',worker_id=NULL,started_at=NULL WHERE job_id=$1",[job.job_id]);return;
      }
      if(reason){
        await this.decision(locked,'skipped',reason);
        await this.store.query("UPDATE browser_jobs SET status='cancelled',cancel_id=COALESCE(cancel_id,$2),cancel_requested_at=COALESCE(cancel_requested_at,now()),finished_at=now(),error='Automatic reproduction invalidated before dispatch.' WHERE job_id=$1",[job.job_id,randomUUID()]);
        return;
      }
      await this.decision(locked,'queued','scheduled');
      allowed=true;
    });
    return allowed;
  }
}
