import { randomUUID } from 'node:crypto';
import type { Store } from './store.js';
import type { BrowserCommand, Capture } from './contracts.js';
import { pageTemplate, transitionKey, type MapState, type StoredProposal } from './app-map.js';
import type { ModelSettings } from './model-client.js';
import type { Viewport, ViewportProfile } from './viewports.js';
import { blockedReason, sameRegisteredSite, type Proposal } from './exploration-policy.js';
import { actionRisk } from './interaction-contract.js';

// Cross-run memory is a derived projection of earlier runs, keyed by observed
// URL and stable control identity (URL, role, name, href). It steers ranking
// and can reopen a remembered page; it never replaces run evidence, and an
// exact screenshot state from another run is never treated as reached.
export const MEMORY_VERSION = 'app-memory-v1';
const MAX_PAGES = 500, MAX_CONTROLS = 5000, MAX_MAP_STATES = 5000, MAX_MAP_TRANSITIONS = 20000;
// A stored ranking is reused this many times; the next visit asks the model
// again and replaces it, so rankings follow model and app changes.
export const MAX_RANKING_REUSES = 10;
export type StoredRanking = { proposals: StoredProposal[]; source_run_id: string; source_request_id: string; source_decision_id: string; reuses: number; created_at: string };
export type AuthScope = 'public' | 'signed_in';
export type MemoryScope = { origin: string; viewport_profile: ViewportProfile; viewport: Viewport; auth_scope: AuthScope; execution_mode: 'live' | 'protocol_fixture' };
export type RememberedPage = { url: string; title: string | null; visits: number; best_path_score: number | null;
  controls_truncated: boolean; last_run_id: string; last_action_id: string | null };
export type RememberedControl = { url: string; control_id: string; role: string; name: string; href: string | null; attempts: number;
  best_likelihood: number | null; last_verdict: 'no_issue_observed' | 'suspect' | 'inconclusive' | null;
  last_observed_result: string | null; blocked_reason: string | null };
// What earlier runs did from one map state: the action, the control entry
// and, for a choice, the option or checkbox value. One row per destination.
export type MapTransition = { from_key: string; control_key: string; to_key: string; entry_key: string | null; action: string;
  control: { role?: string; name?: string; href?: string | null; url?: string; choice?: string | boolean };
  attempts: number; last_verdict: 'no_issue_observed' | 'suspect' | 'inconclusive' | null; last_observed_result: string | null };
export type MapSnapshot = { states: Map<string, { page_template: string; min_depth: number; runs: number }>;
  // Newest first within each state, so the first row is the latest outcome.
  transitions: Map<string, MapTransition[]>;
  // `${state key}|${entry key}` for every entry an earlier run acted on.
  tried: Set<string>; depth_by_template: Map<string, number>; truncated: boolean };
export type MemorySnapshot = { version: typeof MEMORY_VERSION; scope_id: string; scope: MemoryScope; prior_runs: number; truncated: boolean;
  // A requested continuation opens unfinished pages from the stopped run
  // before it repeats the entry page. Ordinary later runs leave this unset.
  prefer_unfinished?: boolean;
  pages: Map<string, RememberedPage>; controls: Map<string, RememberedControl>; by_page: Map<string, RememberedControl[]>;
  // Controls whose action was in flight when a run was interrupted. Their
  // outcome is unknown, so a resumed run never tries them again.
  withheld?: ReadonlySet<string>;
  // The app map earlier runs recorded; absent for runs without memory.
  map?: MapSnapshot };

export function mapSnapshot(stateRows: { state_key: string; page_template: string; min_depth: number; runs: number }[], transitionRows: MapTransition[], truncated = false): MapSnapshot {
  const states = new Map(stateRows.map(s => [s.state_key, { page_template: s.page_template, min_depth: s.min_depth, runs: s.runs }]));
  const transitions = new Map<string, MapTransition[]>(), tried = new Set<string>(), depth = new Map<string, number>();
  for (const t of transitionRows) {
    transitions.set(t.from_key, [...(transitions.get(t.from_key) ?? []), t]);
    if (t.entry_key) tried.add(`${t.from_key}|${t.entry_key}`);
  }
  for (const s of stateRows) depth.set(s.page_template, Math.min(depth.get(s.page_template) ?? Infinity, s.min_depth));
  return { states, transitions, tried, depth_by_template: depth, truncated };
}

// GET links with secrets, one-time tokens or sign-out semantics are never
// reopened from memory, even though an earlier run observed them.
const SENSITIVE_PARAMETER = /token|code|key|secret|session|auth|pass|sig|otp|nonce|state|ticket|invite|reset|verify|confirm/i;
export function jumpableUrl(raw: string, origin: string): boolean {
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (!sameRegisteredSite(origin, url) || url.href.length > 2048) return false;
  let words: string;
  try { words = decodeURIComponent(url.pathname + ' ' + url.search); } catch { return false; }
  words = words.replace(/[/_?=&.+-]+/g, ' ');
  if (actionRisk(words) || /\b(log|sign)[ -]?(out|off)\b/i.test(words)) return false;
  return ![...url.searchParams.keys()].some(key => SENSITIVE_PARAMETER.test(key));
}

// A resumed exploration continues an interrupted job in a new run. The earlier
// runs' own records stand in for memory, even when app memory is off.
export async function resumeSnapshot(store: Store, runIds: string[], scope: MemoryScope): Promise<MemorySnapshot> {
  const pageRows = (await store.query(`SELECT s.url,(array_agg(c.observation->>'title' ORDER BY s.created_at DESC))[1] AS title,count(*)::int AS visits,
      bool_or(COALESCE((c.observation->>'controls_truncated')::boolean,false)) AS controls_truncated,(array_agg(s.run_id ORDER BY s.created_at DESC))[1] AS last_run_id
    FROM exploration_states s JOIN runtime_captures c ON c.capture_id=s.representative_capture_id
    WHERE s.run_id=ANY($1::uuid[]) GROUP BY s.url ORDER BY max(s.created_at) DESC LIMIT $2`, [runIds, MAX_PAGES + 1])).rows;
  const controlRows = (await store.query(`SELECT s.url,f.control_id,(array_agg(f.control))[1] AS control,count(DISTINCT f.action_id)::int AS attempts,
      (array_agg(a.assessment->>'verdict' ORDER BY a.ordinal DESC) FILTER (WHERE a.state='completed'))[1] AS last_verdict,
      (array_agg(left(a.assessment->>'observed_result',300) ORDER BY a.ordinal DESC) FILTER (WHERE a.state='completed'))[1] AS last_observed_result,
      (array_agg(f.reason) FILTER (WHERE f.status='blocked'))[1] AS blocked_reason,
      bool_or(a.dispatched_at IS NOT NULL AND a.state IN ('interrupted','evidence_failed','cancelled')) AS unknown_outcome
    FROM exploration_frontier f JOIN exploration_states s ON s.run_id=f.run_id AND s.state_id=f.state_id
    LEFT JOIN runtime_actions a ON a.action_id=f.action_id
    WHERE f.run_id=ANY($1::uuid[]) AND f.control->>'role'<>'scroll' GROUP BY s.url,f.control_id LIMIT $2`, [runIds, MAX_CONTROLS + 1])).rows;
  const pages = new Map<string, RememberedPage>(pageRows.slice(0, MAX_PAGES).map(p => [p.url, { url: p.url, title: p.title, visits: p.visits,
    best_path_score: null, controls_truncated: p.controls_truncated, last_run_id: p.last_run_id, last_action_id: null }]));
  const controls = new Map<string, RememberedControl>(), byPage = new Map<string, RememberedControl[]>(), withheld = new Set<string>();
  for (const c of controlRows.slice(0, MAX_CONTROLS)) {
    if (c.unknown_outcome) withheld.add(c.control_id);
    if (!pages.has(c.url)) continue;
    const remembered: RememberedControl = { url: c.url, control_id: c.control_id, role: c.control.role, name: c.control.name, href: c.control.href ?? null,
      attempts: c.attempts, best_likelihood: null, last_verdict: c.last_verdict ?? null, last_observed_result: c.last_observed_result ?? null, blocked_reason: c.blocked_reason ?? null };
    controls.set(c.control_id, remembered);
    byPage.set(c.url, [...(byPage.get(c.url) ?? []), remembered]);
  }
  return { version: MEMORY_VERSION, scope_id: runIds.at(-1)!, scope, prior_runs: runIds.length,
    truncated: pageRows.length > MAX_PAGES || controlRows.length > MAX_CONTROLS, pages, controls, by_page: byPage, withheld };
}

export class AppMemory {
  private constructor(private readonly store: Store, private readonly runId: string, readonly snapshot: MemorySnapshot | null) {}
  static disabled(store: Store, runId: string) { return new AppMemory(store, runId, null); }
  get enabled() { return this.snapshot !== null; }

  // Must run inside the caller's transaction. The snapshot is frozen when the
  // run (or a new sign-in context) starts, so it describes earlier runs only.
  static async open(store: Store, runId: string, scope: MemoryScope) {
    const row = (await store.query(`INSERT INTO app_memory_scopes(scope_id,workspace_id,user_id,origin,viewport_profile,viewport_width,viewport_height,auth_scope,execution_mode,runs,last_run_id)
      VALUES($1,$2,$3,$4,$5,$9,$10,$6,$7,1,$8)
      ON CONFLICT(workspace_id,user_id,origin,viewport_profile,viewport_width,viewport_height,auth_scope,execution_mode) DO UPDATE SET
        runs=app_memory_scopes.runs+CASE WHEN app_memory_scopes.last_run_id IS DISTINCT FROM EXCLUDED.last_run_id THEN 1 ELSE 0 END,
        last_run_id=EXCLUDED.last_run_id,updated_at=now()
      RETURNING scope_id,runs`, [randomUUID(), store.workspaceId, store.userId, scope.origin, scope.viewport_profile, scope.auth_scope, scope.execution_mode, runId,
        scope.viewport.width, scope.viewport.height])).rows[0];
    const pageRows = (await store.query(`SELECT url,title,visits,best_path_score,controls_truncated,last_run_id,last_action_id FROM app_memory_pages
      WHERE scope_id=$1 ORDER BY last_seen_at DESC,url LIMIT $2`, [row.scope_id, MAX_PAGES + 1])).rows;
    const pages = new Map<string, RememberedPage>(pageRows.slice(0, MAX_PAGES).map(p => [p.url, { url: p.url, title: p.title, visits: p.visits,
      best_path_score: p.best_path_score, controls_truncated: p.controls_truncated, last_run_id: p.last_run_id, last_action_id: p.last_action_id }]));
    const controlRows = pages.size ? (await store.query(`SELECT url,control_id,control,attempts,best_likelihood,last_verdict,last_observed_result,blocked_reason
      FROM app_memory_controls WHERE scope_id=$1 AND url=ANY($2::text[]) ORDER BY last_seen_at DESC,url,control_id LIMIT $3`,
      [row.scope_id, [...pages.keys()], MAX_CONTROLS + 1])).rows : [];
    const controls = new Map<string, RememberedControl>(), byPage = new Map<string, RememberedControl[]>();
    for (const c of controlRows.slice(0, MAX_CONTROLS)) {
      const remembered: RememberedControl = { url: c.url, control_id: c.control_id, role: c.control.role, name: c.control.name, href: c.control.href ?? null,
        attempts: c.attempts, best_likelihood: c.best_likelihood, last_verdict: c.last_verdict, last_observed_result: c.last_observed_result, blocked_reason: c.blocked_reason };
      controls.set(c.control_id, remembered);
      byPage.set(c.url, [...(byPage.get(c.url) ?? []), remembered]);
    }
    const mapStates = (await store.query(`SELECT state_key,page_template,min_depth,runs FROM app_map_states WHERE scope_id=$1
      ORDER BY last_seen_at DESC,state_key LIMIT $2`, [row.scope_id, MAX_MAP_STATES + 1])).rows;
    const mapTransitions = (await store.query(`SELECT from_key,control_key,to_key,entry_key,action,control,attempts,last_verdict,last_observed_result
      FROM app_map_transitions WHERE scope_id=$1 ORDER BY last_seen_at DESC,from_key,control_key,to_key LIMIT $2`, [row.scope_id, MAX_MAP_TRANSITIONS + 1])).rows;
    const map = mapSnapshot(mapStates.slice(0, MAX_MAP_STATES), mapTransitions.slice(0, MAX_MAP_TRANSITIONS) as MapTransition[],
      mapStates.length > MAX_MAP_STATES || mapTransitions.length > MAX_MAP_TRANSITIONS);
    return new AppMemory(store, runId, { version: MEMORY_VERSION, scope_id: row.scope_id, scope, prior_runs: row.runs - 1,
      truncated: pageRows.length > MAX_PAGES || controlRows.length > MAX_CONTROLS, pages, controls, by_page: byPage, map });
  }

  summary() {
    const s = this.snapshot;
    return s ? { version: MEMORY_VERSION, enabled: true, scope_id: s.scope_id, ...s.scope, prior_runs: s.prior_runs,
      remembered_pages: s.pages.size, remembered_controls: s.controls.size, snapshot_truncated: s.truncated,
      map_states: s.map?.states.size ?? 0, map_transitions: [...s.map?.transitions.values() ?? []].reduce((n, rows) => n + rows.length, 0) }
      : { version: MEMORY_VERSION, enabled: false };
  }

  // The writers below are plain statements for the caller's open transaction,
  // so memory commits together with the evidence it was derived from.
  async observe(capture: Capture, pathScore: number) {
    const s = this.snapshot, o = capture.observation;
    if (!s || o.observation_error) return;
    let page: URL;
    try { page = new URL(o.url); } catch { return; }
    if (!sameRegisteredSite(s.scope.origin, page) || o.url.length > 2048) return;
    await this.store.query(`INSERT INTO app_memory_pages(scope_id,url,title,visits,best_path_score,controls_truncated,first_run_id,last_run_id,last_action_id)
      VALUES($1,$2,$3,1,$4,$5,$6,$6,$7)
      ON CONFLICT(scope_id,url) DO UPDATE SET title=EXCLUDED.title,
        visits=app_memory_pages.visits+CASE WHEN app_memory_pages.last_run_id=EXCLUDED.last_run_id THEN 0 ELSE 1 END,
        best_path_score=GREATEST(app_memory_pages.best_path_score,EXCLUDED.best_path_score),controls_truncated=EXCLUDED.controls_truncated,
        last_run_id=EXCLUDED.last_run_id,last_action_id=EXCLUDED.last_action_id,last_seen_at=now()`,
      [s.scope_id, o.url, o.title?.slice(0, 200) ?? null, Math.min(1, Math.max(0, pathScore)), o.controls_truncated ?? false, this.runId, capture.action_id]);
    // Page scroll affordances are positional, not application features.
    const controls = (o.controls ?? []).filter(c => c.role !== 'scroll').map(c => ({ control_id: c.control_id,
      control: { role: c.role, name: c.name, href: c.href }, blocked_reason: blockedReason(c, s.scope.origin) }));
    if (!controls.length) return;
    await this.store.query(`INSERT INTO app_memory_controls(scope_id,url,control_id,control,blocked_reason,first_run_id,last_run_id)
      SELECT $1,$2,c.control_id,c.control,c.blocked_reason,$3,$3 FROM jsonb_to_recordset($4::jsonb) AS c(control_id text,control jsonb,blocked_reason text)
      ON CONFLICT(scope_id,url,control_id) DO UPDATE SET control=EXCLUDED.control,blocked_reason=EXCLUDED.blocked_reason,
        observations=app_memory_controls.observations+CASE WHEN app_memory_controls.last_run_id=EXCLUDED.last_run_id THEN 0 ELSE 1 END,
        last_run_id=EXCLUDED.last_run_id,last_seen_at=now()`, [s.scope_id, o.url, this.runId, JSON.stringify(controls)]);
  }
  async proposed(url: string, proposals: Proposal[]) {
    if (!this.snapshot || !proposals.length) return;
    await this.store.query(`UPDATE app_memory_controls m SET best_likelihood=GREATEST(COALESCE(m.best_likelihood,0),p.likelihood)
      FROM jsonb_to_recordset($3::jsonb) AS p(control_id text,likelihood double precision)
      WHERE m.scope_id=$1 AND m.url=$2 AND m.control_id=p.control_id`,
      [this.snapshot.scope_id, url, JSON.stringify(proposals.map(p => ({ control_id: p.control_id, likelihood: p.likelihood })))]);
  }
  async attempted(url: string, controlId: string, actionId: string) {
    if (!this.snapshot) return;
    await this.store.query(`UPDATE app_memory_controls SET attempts=attempts+1,last_attempted_at=now(),last_action_id=$4,last_run_id=$5
      WHERE scope_id=$1 AND url=$2 AND control_id=$3`, [this.snapshot.scope_id, url, controlId, actionId, this.runId]);
  }
  async assessed(url: string, controlId: string, actionId: string, verdict: string, observed: string) {
    if (!this.snapshot) return;
    await this.store.query(`UPDATE app_memory_controls SET last_verdict=$4,last_observed_result=$5,last_action_id=$6
      WHERE scope_id=$1 AND url=$2 AND control_id=$3`, [this.snapshot.scope_id, url, controlId, verdict, observed.slice(0, 300), actionId]);
  }

  // The app map: states and transitions carried between runs. Rows commit with
  // the evidence they describe, and only runs that use memory write them.
  async mapState(state: MapState, depth: number, url: string) {
    const s = this.snapshot;
    if (!s) return;
    await this.store.query(`INSERT INTO app_map_states(scope_id,state_key,page_template,example_url,title,controls,controls_truncated,min_depth,first_run_id,last_run_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
      ON CONFLICT(scope_id,state_key) DO UPDATE SET example_url=EXCLUDED.example_url,title=EXCLUDED.title,controls=EXCLUDED.controls,
        controls_truncated=EXCLUDED.controls_truncated,observations=app_map_states.observations+1,
        runs=app_map_states.runs+CASE WHEN app_map_states.last_run_id IS DISTINCT FROM EXCLUDED.last_run_id THEN 1 ELSE 0 END,
        min_depth=LEAST(app_map_states.min_depth,EXCLUDED.min_depth),last_run_id=EXCLUDED.last_run_id,last_seen_at=now()`,
      [s.scope_id, state.key, state.page_template, url.slice(0, 2048), state.title, JSON.stringify(state.controls), state.controls_truncated, depth, this.runId]);
  }
  async mapTransition(from: string, to: string, command: BrowserCommand, verdict: string, observed: string, actionId: string) {
    const s = this.snapshot;
    if (!s) return;
    const { key, entry } = transitionKey(command);
    // A chosen option or checkbox value is kept so a later run can re-walk it.
    const choice = command.type === 'select' ? { choice: command.value } : command.type === 'set_checked' ? { choice: command.checked } : {};
    const control = command.type === 'navigate' ? { url: pageTemplate(command.url) }
      : { role: command.control.role, name: command.control.name.slice(0, 200), href: command.control.href ? pageTemplate(command.control.href) : null, ...choice };
    await this.store.query(`INSERT INTO app_map_transitions(scope_id,from_key,control_key,to_key,entry_key,action,control,verdicts,last_verdict,last_observed_result,first_run_id,last_run_id,last_action_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,jsonb_build_object($8::text,1),$8,$9,$10,$10,$11)
      ON CONFLICT(scope_id,from_key,control_key,to_key) DO UPDATE SET attempts=app_map_transitions.attempts+1,
        verdicts=app_map_transitions.verdicts||jsonb_build_object($8::text,COALESCE((app_map_transitions.verdicts->>$8)::int,0)+1),
        last_verdict=EXCLUDED.last_verdict,last_observed_result=EXCLUDED.last_observed_result,last_run_id=EXCLUDED.last_run_id,
        last_action_id=EXCLUDED.last_action_id,last_seen_at=now()`,
      [s.scope_id, from, key, to, entry, command.type, JSON.stringify(control), verdict, observed.slice(0, 300), this.runId, actionId]);
  }

  // Rankings for one screen signature and model. Reads see earlier runs and
  // this run alike; a run reuses a ranking only on a screen's first visit.
  async ranking(signature: string, model: ModelSettings): Promise<StoredRanking | null> {
    if (!this.snapshot) return null;
    return (await this.store.query(`SELECT proposals,source_run_id,source_request_id,source_decision_id,reuses,created_at FROM app_map_rankings
      WHERE scope_id=$1 AND signature=$2 AND provider=$3 AND model=$4 AND reuses<$5`, [this.snapshot.scope_id, signature, model.provider, model.model, MAX_RANKING_REUSES])).rows[0] ?? null;
  }
  async storeRanking(signature: string, model: ModelSettings, stateKey: string | null, proposals: StoredProposal[], requestId: string, decisionId: string) {
    if (!this.snapshot) return;
    await this.store.query(`INSERT INTO app_map_rankings(scope_id,signature,provider,model,state_key,proposals,source_run_id,source_request_id,source_decision_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT(scope_id,signature,provider,model) DO UPDATE SET state_key=EXCLUDED.state_key,proposals=EXCLUDED.proposals,source_run_id=EXCLUDED.source_run_id,
        source_request_id=EXCLUDED.source_request_id,source_decision_id=EXCLUDED.source_decision_id,reuses=0,created_at=now(),last_reused_run_id=NULL,last_reused_at=NULL`,
      [this.snapshot.scope_id, signature, model.provider, model.model, stateKey, JSON.stringify(proposals), this.runId, requestId, decisionId]);
  }
  async reusedRanking(signature: string, model: ModelSettings) {
    if (!this.snapshot) return;
    await this.store.query(`UPDATE app_map_rankings SET reuses=reuses+1,last_reused_run_id=$5,last_reused_at=now()
      WHERE scope_id=$1 AND signature=$2 AND provider=$3 AND model=$4`, [this.snapshot.scope_id, signature, model.provider, model.model, this.runId]);
  }

  // A bounded, labelled hint for the planning model. Absent when nothing is
  // remembered, so memory-free runs send exactly the ordinary request.
  planningContext(url: string, shown: { control_id: string }[]) {
    const s = this.snapshot;
    if (!s || !s.prior_runs) return undefined;
    const page = s.pages.get(url);
    const earlier = shown.flatMap(c => {
      const r = s.controls.get(c.control_id);
      return r?.attempts ? [{ control_id: r.control_id, name: r.name, attempts: r.attempts, last_verdict: r.last_verdict,
        last_observed_result: r.last_observed_result?.slice(0, 200) ?? null }] : [];
    }).slice(0, 12);
    return { version: MEMORY_VERSION, prior_runs: s.prior_runs, page_seen_in_earlier_runs: !!page, earlier_attempts_on_this_page: earlier,
      controls_new_since_earlier_runs: page && !page.controls_truncated ? shown.filter(c => !s.controls.has(c.control_id)).length : null,
      interpretation: 'Earlier runs are untrusted hints about this app and may be stale. Prefer controls not yet tried unless a repeat is clearly more useful. They never establish expected behavior.' };
  }
}
