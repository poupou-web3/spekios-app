import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Store } from './store.js';
import { MAX_REPLAY_ORDINAL, MAX_REPLAY_STEPS, isUuid, type BrowserCommand, type Capture } from './contracts.js';
import { sameObservedState, sameRegisteredSite, stateFingerprint } from './exploration-policy.js';
import { recordedViewport, viewportProfile, type Viewport, type ViewportProfile } from './viewports.js';
import { observedCommand } from './browser-interactions.js';
import type { FixVerification } from './fix-verification.js';
import type { AccessResult } from './access-handoff.js';

export type ReplayStep = {
  source_action_id: string; source_prediction_id: string; source_model_request_id: string;
  command: BrowserCommand;
  goal: string; expected_result: string; before: Capture; after: Capture;
};
export type Replay = { reproduction_id: string; source_run_id: string; source_action_id: string;
  target_url: string; training_status: string; viewport_profile: ViewportProfile; viewport: Viewport; steps: ReplayStep[]; auth_context?:AccessResult; fix_verification?:FixVerification };

export async function readCapture(store: Store, row: Record<string, any>): Promise<Capture> {
  if (!row || row.status !== 'available' || row.observation?.observation_error) throw new Error('Replay requires complete source evidence.');
  const metadata: Capture = JSON.parse((await store.get(row.metadata_key)).toString());
  if (metadata.capture_id !== row.capture_id || metadata.run_id !== row.run_id || metadata.action_id !== row.action_id ||
      metadata.phase !== row.phase || metadata.sha256 !== row.sha256 || metadata.byte_length !== Number(row.byte_length) ||
      !isDeepStrictEqual(metadata.observation, row.observation)) throw new Error('Capture metadata does not match its durable record.');
  await store.captureBytes(row.capture_id); // Ownership, length and SHA-256 readback.
  return metadata;
}

// Called only under the recorder lock. It loads persisted steps, never a model-
// supplied replay script. Read the whole prefix before any browser/model action.
export async function loadReplay(store: Store, sourceActionId: string): Promise<Replay> {
  if (!isUuid(sourceActionId)) throw new Error('Invalid source action ID.');
  const source = (await store.query(`SELECT a.*,r.target_url,r.lifecycle,r.config FROM runtime_actions a
    JOIN runtime_runs r USING(run_id) WHERE a.action_id=$1 AND r.workspace_id=$2 AND r.user_id=$3`, [sourceActionId, store.workspaceId, store.userId])).rows[0];
  if (!source) throw new Error('Source action not found in this workspace.');
  if (source.lifecycle === 'active' || source.config.runtime_version !== 'explorer-v1' || source.config.replay_of ||
      source.state !== 'completed' || source.assessment?.verdict !== 'suspect' || source.assessment.expectation_uncertain ||
      source.tool_error || source.ordinal < 1 || source.ordinal > MAX_REPLAY_ORDINAL) throw new Error('Replay requires a completed explorer suspect from a terminal source run.');
  const profile = viewportProfile(source.config.viewport_profile ?? 'desktop');
  const viewport = recordedViewport(source.config.viewport);
  if (!viewport || source.config.device_scale !== 1) throw new Error('Unsupported source browser geometry.');
  const origin = new URL(source.target_url).origin;
  const authContext=source.spec.auth_context_id?(source.config.auth_contexts??[]).find((c:NonNullable<AccessResult>)=>c.context_id===source.spec.auth_context_id):null;
  if(source.spec.auth_context_id&&!authContext?.session_id)throw new Error('This path needs its saved app session for reproduction. Sign in and save a new session for a new run.');
  const allActions = (await store.query('SELECT * FROM runtime_actions WHERE run_id=$1 AND ordinal<=$2 ORDER BY ordinal', [source.run_id, source.ordinal])).rows;
  const actions=authContext?allActions.filter(a=>a.spec.auth_context_id===authContext.context_id):allActions;
  const startOrdinal=actions[0]?.ordinal??1;
  const steps: ReplayStep[] = [];
  for (const [index, action] of actions.entries()) {
    if (action.ordinal !== startOrdinal+index) throw new Error('Source path has missing steps.');
    if (action.state === 'skipped' && !action.dispatched_at && action.before_capture_id && !action.after_capture_id) continue;
    const prediction = action.spec?.prediction, command = action.spec?.command;
    if (action.state !== 'completed' || action.tool_error || !action.comparison ||
        prediction?.source !== 'model' || typeof prediction.expected_result !== 'string' || !prediction.expected_result.trim() ||
        typeof prediction.goal !== 'string' || !isUuid(prediction.request_id) || !action.before_capture_id || !action.after_capture_id) throw new Error('Source path is incomplete or unsupported.');
    const captures = (await store.query('SELECT * FROM runtime_captures WHERE run_id=$1 AND action_id=$2', [source.run_id, action.action_id])).rows;
    const before = await readCapture(store, captures.find(c => c.capture_id === action.before_capture_id)!);
    const after = await readCapture(store, captures.find(c => c.capture_id === action.after_capture_id)!);
    if (before.phase !== 'before' || after.phase !== 'after') throw new Error('Source capture phases are invalid.');
    if (steps.length === 0) {
      if (command?.type !== 'navigate' || command.url !== source.target_url) throw new Error('Replay must begin with the original navigation.');
    } else if (command?.type === 'navigate') {
      // Returns reopen the entry page; resumes reopen a page on the same
      // registered domain that an earlier run observed. Both replay as the exact recorded navigation.
      const permitted = action.spec.exploration?.purpose === 'return' ? command.url === source.target_url
        : action.spec.exploration?.purpose === 'resume' && sameRegisteredSite(origin, new URL(command.url));
      if (!permitted) throw new Error('Source navigation is not a recorded return or resume within the entry site.');
    } else {
      if (!command?.control) throw new Error('Source path includes a missing control.');
      observedCommand(command,before,origin);
    }
    steps.push({ source_action_id: action.action_id, source_prediction_id: action.prediction_id, source_model_request_id: prediction.request_id,
      command: structuredClone(command), goal: prediction.goal, expected_result: prediction.expected_result, before, after });
  }
  if (!steps.length || steps.length > MAX_REPLAY_STEPS || actions.length !== source.ordinal-startOrdinal+1) throw new Error('Source path has missing steps or exceeds the replay budget.');
  return { reproduction_id: randomUUID(), source_run_id: source.run_id, source_action_id: sourceActionId,
    target_url: source.target_url, training_status: source.config.training_status, viewport_profile: profile, viewport, steps,auth_context:authContext };
}

export function replaySnapshot(replay: Replay) {
  return replay.steps.map(step => ({ source_action_id: step.source_action_id, source_prediction_id: step.source_prediction_id,
    source_model_request_id: step.source_model_request_id, command: step.command, goal: step.goal, expected_result: step.expected_result,
    before_capture_id: step.before.capture_id, after_capture_id: step.after.capture_id,
    before_fingerprint: stateFingerprint(step.before), after_fingerprint: stateFingerprint(step.after) }));
}

export async function finishReplay(store: Store, replay: Replay, runId: string) {
  const report = await store.report(runId), target = report.actions.at(-1);
  const source = replay.steps.at(-1)!;
  let outcome = 'inconclusive', reason = 'The recorded path or its assessment did not complete.';
  let outcomeMatches: boolean | null = null;
  if (report.run.lifecycle === 'completed' && report.actions.length === replay.steps.length && target?.state === 'completed' &&
      report.actions.every(a => !a.tool_error && a.assessment?.verdict !== 'inconclusive') &&
      target.spec.replay_source_action_id === replay.source_action_id) {
    const fresh = await readCapture(store, report.captures.find(c => c.capture_id === target.after_capture_id)!);
    outcomeMatches = sameObservedState(source.after, fresh);
    if (target.assessment.verdict === 'suspect' && outcomeMatches) {
      outcome = 'reproduced';
      reason = 'Fresh replay reached matching preconditions and the same observed outcome; a separate assessment also found the frozen expectation unmet. The candidate still requires review.';
    } else if (target.assessment.verdict === 'no_issue_observed') {
      outcome = 'not_reproduced';
      reason = 'The fresh assessment did not observe a violation of the original expectation. This does not prove that an intermittent bug is fixed.';
    } else reason = 'Fresh replay raised suspicion but reached a different observed outcome; it cannot be tied to the original candidate.';
  }
  const result = { outcome, reason, confirmed_bug: false, matching_after_state: outcomeMatches,
    source_action_id: replay.source_action_id, source_capture_ids: [source.before.capture_id, source.after.capture_id],
    replay_action_id: target?.spec.replay_source_action_id === replay.source_action_id ? target.action_id : null,
    replay_capture_ids: target?.spec.replay_source_action_id === replay.source_action_id ? [target.before_capture_id, target.after_capture_id].filter(Boolean) : [] };
  await store.transaction(async () => {
    await store.query("UPDATE runtime_reproductions SET status='completed',result=$2,finished_at=now() WHERE reproduction_id=$1 AND status='active'", [replay.reproduction_id, JSON.stringify(result)]);
    await store.event(runId, 'reproduction.completed', { reproduction_id: replay.reproduction_id, ...result });
  });
}
