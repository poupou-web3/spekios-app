import {isDeepStrictEqual} from 'node:util';
import {randomUUID} from 'node:crypto';
import type {Store} from './store.js';
import {hash} from './store.js';
import type {BrowserCommand,Capture,ObservedControl} from './contracts.js';
import {isUuid} from './contracts.js';
import {loadReplay,readCapture,type Replay,type ReplayStep} from './reproduction.js';
import {findObservedControl,parseAssessment,sameObservedState} from './exploration-policy.js';
import type {AccessResult} from './access-handoff.js';

export type FixVerification={verification_id:string;issue_id:string;source_entry:string;candidate_url:string;original:Record<string,any>;requires_session:boolean};
export function remapUrl(raw:string,sourceEntry:string,candidateEntry:string):string {
  const url=new URL(raw),source=new URL(sourceEntry),candidate=new URL(candidateEntry);
  if(url.origin!==source.origin)return raw;
  if(url.pathname===source.pathname&&url.search===source.search){const mapped=new URL(candidate);mapped.hash=url.hash===source.hash?candidate.hash:url.hash;return mapped.href;}
  url.protocol=candidate.protocol;url.host=candidate.host;return url.href;
}
function remapControl(control:ObservedControl,source:string,candidate:string):ObservedControl {
  return {...control,href:control.href?remapUrl(control.href,source,candidate):null,
    ...(control.form?{form:{...control.form,action:remapUrl(control.form.action,source,candidate)}}:{})};
}
export function remapCommand(command:BrowserCommand,source:string,candidate:string):BrowserCommand {
  return command.type==='navigate'?{...command,url:remapUrl(command.url,source,candidate)}:{...command,control:remapControl(command.control,source,candidate)};
}
// Deployment pixels may change. Match the recorded route, page copy and native
// control state, with the same clock and scroll tolerance as exploration.
// Every screenshot is still stored separately.
export function preconditionsMatch(source:Capture,fresh:Capture,sourceEntry:string,candidateEntry:string):boolean {
  return sameObservedState(source,fresh,url=>remapUrl(url,sourceEntry,candidateEntry));
}
export function bindVerificationCommand(step:ReplayStep,fresh:Capture,verification:FixVerification):BrowserCommand {
  if(!preconditionsMatch(step.before,fresh,verification.source_entry,verification.candidate_url))throw new Error('Candidate preconditions differ from the recorded behavior. No action dispatched.');
  if(step.command.type==='navigate')return step.command;
  if(step.command.type==='computer'){
    if(step.command.screenshot_sha256!==fresh.sha256)throw new Error('Candidate visual preconditions changed. No computer gesture dispatched.');
    return step.command;
  }
  const control=findObservedControl(step.command.control,fresh.observation.controls??[]);
  if(!control)throw new Error('The recorded candidate control does not resolve uniquely. No action dispatched.');
  return {...step.command,control};
}
export async function loadVerification(store:Store,id:string,sessionId?:string,authMode?:string):Promise<Replay> {
  if(!isUuid(id))throw new Error('Invalid verification ID.');
  const record=(await store.query('SELECT v.*,i.source_run_id,i.source_action_id,i.source_target_url FROM issue_verifications v JOIN issues i USING(issue_id,workspace_id) WHERE verification_id=$1 AND v.workspace_id=$2 AND v.user_id=$3',[id,store.workspaceId,store.userId])).rows[0];
  if(!record||record.status!=='running'||record.run_id||record.outcome)throw new Error('Verification is unavailable or already started. Actions are never resumed automatically.');
  const source=(await store.query('SELECT scout_issue_path(a.run_id,a.ordinal) AS path FROM runtime_actions a WHERE action_id=$1 AND run_id=$2',[record.source_action_id,record.source_run_id])).rows[0];
  if(!source||!isDeepStrictEqual(source.path,record.source_snapshot.path))throw new Error('The frozen source path no longer matches its records.');
  const replay=await loadReplay(store,record.source_action_id);
  const original=record.source_snapshot.issue;
  if(replay.steps.at(-1)?.expected_result!==original.expected_result||replay.steps.at(-1)?.before.capture_id!==original.before_capture_id||replay.steps.at(-1)?.after.capture_id!==original.after_capture_id)throw new Error('Frozen issue evidence no longer matches its source.');
  const sourceAuth=replay.auth_context;
  const sameOrigin=new URL(record.candidate_url).origin===new URL(record.source_target_url).origin;
  const auth:AccessResult=sessionId?{context_id:sessionId,session_id:sessionId,verification:'saved_session_reused'}:authMode!=='public'&&sameOrigin?sourceAuth??null:null;
  return {...replay,reproduction_id:randomUUID(),target_url:record.candidate_url,auth_context:auth,
    steps:replay.steps.map(step=>({...step,command:remapCommand(step.command,record.source_target_url,record.candidate_url)})),
    fix_verification:{verification_id:id,issue_id:record.issue_id,source_entry:record.source_target_url,candidate_url:record.candidate_url,original,requires_session:!!sourceAuth}};
}
export function parseFixAssessment(raw:unknown,captures:string[]){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('Expected a verification assessment object.');
  const value=raw as Record<string,unknown>;
  const extra=['expectation_met','preconditions_met','same_failure_observed'];
  const standard=Object.fromEntries(Object.entries(value).filter(([key])=>!extra.includes(key)));
  const assessment=parseAssessment(standard,captures);
  const nullableBoolean=(value:unknown):value is boolean|null=>value===null||typeof value==='boolean';
  if(typeof value.preconditions_met!=='boolean'||!nullableBoolean(value.expectation_met)||!nullableBoolean(value.same_failure_observed))throw new Error('Verification needs explicit expectation and precondition results.');
  if(value.expectation_met===true&&value.same_failure_observed===true)throw new Error('Contradictory verification result.');
  return {...assessment,fix_check:{expectation_met:value.expectation_met,preconditions_met:value.preconditions_met,same_failure_observed:value.same_failure_observed}};
}
function recordedPathCompleted(report:Record<string,any>,replay:Replay):boolean {
  if(report.actions.length!==replay.steps.length)return false;
  return report.actions.every((action:any,index:number)=>{
    const completed=action.state==='completed'&&!action.tool_error&&action.outcome?.status==='settled';
    const matchesSource=action.spec.replay_source_action_id===replay.steps[index].source_action_id;
    const usableAssessment=!action.assessment?.expectation_uncertain;
    const prerequisitePassed=index===replay.steps.length-1||action.assessment?.verdict==='no_issue_observed';
    return completed&&matchesSource&&usableAssessment&&prerequisitePassed;
  });
}
export function verificationOutcome(report:Record<string,any>,replay:Replay,evidenceVerified:boolean){
  const target=report.actions.at(-1);
  let outcome:'resolved'|'still_reproducible'|'blocked'|'inconclusive'='inconclusive';
  let reason='The recorded behavior was not fully checked. An incomplete or failed replay does not establish a fix.';
  if(report.run.lifecycle==='blocked'){outcome='blocked';reason='Access or policy prevented verification. Sign in to this candidate through Scout, save its session, then retry with a new verification ID.';}
  else if(report.run.lifecycle==='completed'&&!report.run.cancel_id&&evidenceVerified&&recordedPathCompleted(report,replay)){
    const check=target?.assessment?.fix_check;
    if(check?.preconditions_met===true&&check.expectation_met===true&&check.same_failure_observed===false&&target.assessment.verdict==='no_issue_observed'){
      outcome='resolved';reason='A fresh browser followed the frozen path and positively observed the recorded expected behavior on this candidate.';
    }else if(check?.preconditions_met===true&&check.expectation_met===false&&check.same_failure_observed===true&&target.assessment.verdict==='suspect'){
      outcome='still_reproducible';reason='A fresh browser reached the recorded preconditions and observed the same failure against the frozen expectation.';
    }else reason='The assessment did not establish the expected behavior or confidently identify the original failure under matching preconditions.';
  }
  return {outcome,reason,expected_result:replay.fix_verification!.original.expected_result,observed_result:target?.assessment?.observed_result??null,
    source_run_id:replay.source_run_id,source_action_id:replay.source_action_id,candidate_run_id:report.run.run_id,
    candidate_action_id:target?.spec.replay_source_action_id===replay.source_action_id?target.action_id:null,
    source_capture_ids:[replay.steps.at(-1)!.before.capture_id,replay.steps.at(-1)!.after.capture_id],
    candidate_capture_ids:target?.spec.replay_source_action_id===replay.source_action_id?[target.before_capture_id,target.after_capture_id].filter(Boolean):[],
    candidate_url:replay.target_url,evidence_verified:evidenceVerified,positive_expectation_check:outcome==='resolved',
    recorded_steps:report.actions.map((a:any)=>({source_action_id:a.spec.replay_source_action_id,candidate_action_id:a.action_id,expected_result:a.spec.prediction.expected_result,before_capture_id:a.before_capture_id,after_capture_id:a.after_capture_id,state:a.state})),
    assessment_request_id:target?.assessment?.request_id??null,assessment_scope:'recorded_behavior_on_this_candidate',verified_fixed_globally:false,confirmed_bug:false,coverage_complete:false};
}
export async function finishVerification(store:Store,replay:Replay,runId:string){
  const report=await store.report(runId);let verified=false;
  try{
    if(report.actions.length!==replay.steps.length)throw new Error('Incomplete path.');
    for(const action of report.actions){
      await readCapture(store,report.captures.find(c=>c.capture_id===action.before_capture_id)!);
      await readCapture(store,report.captures.find(c=>c.capture_id===action.after_capture_id)!);
      for(const ref of [action.comparison?.raw_mask_artifact,action.comparison?.absolute_delta_artifact,action.comparison?.metadata_artifact,action.outcome?.completion_artifact,action.outcome?.diagnostics_artifact]){
        const row=report.artifacts.find(a=>a.artifact_id===ref?.artifact_id);
        if(!row||row.status!=='available'||row.sha256!==ref.sha256||Number(row.byte_length)!==ref.byte_length)throw new Error('Incomplete action artifact.');
        const bytes=await store.get(row.object_key);if(hash(bytes)!==row.sha256||bytes.length!==Number(row.byte_length))throw new Error('Action artifact failed verification.');
      }
    }
    verified=true;
  }catch{/* A missing or corrupt object can never establish a resolved issue. */}
  const result=verificationOutcome(report,replay,verified);
  await store.transaction(async()=>{
    const updated=await store.query("UPDATE issue_verifications SET status='completed',outcome=$2,result=$3,run_id=$4,finished_at=now() WHERE verification_id=$1 AND workspace_id=$5 AND user_id=$6 AND outcome IS NULL RETURNING verification_id",[replay.fix_verification!.verification_id,result.outcome,JSON.stringify(result),runId,store.workspaceId,store.userId]);
    if(updated.rowCount)await store.event(runId,'verification.completed',{verification_id:replay.fix_verification!.verification_id,issue_id:replay.fix_verification!.issue_id,...result});
  });
}
