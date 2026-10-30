import { randomUUID } from 'node:crypto';
import type { Store } from './store.js';
import type { Capture } from './contracts.js';
import type { ViewportProfile } from './viewports.js';
import { blockedReason, type Proposal } from './exploration-policy.js';
import { actionRisk } from './interaction-contract.js';

// Cross-run memory is a derived projection of earlier runs, keyed by observed
// URL and stable control identity (URL, role, name, href). It steers ranking
// and can reopen a remembered page; it never replaces run evidence, and an
// exact screenshot state from another run is never treated as reached.
export const MEMORY_VERSION = 'app-memory-v1';
const MAX_PAGES = 500, MAX_CONTROLS = 5000;
export type AuthScope = 'public' | 'signed_in';
export type MemoryScope = { origin: string; viewport_profile: ViewportProfile; auth_scope: AuthScope; execution_mode: 'live' | 'protocol_fixture' };
export type RememberedPage = { url: string; title: string | null; visits: number; best_path_score: number | null;
  controls_truncated: boolean; last_run_id: string; last_action_id: string | null };
export type RememberedControl = { url: string; control_id: string; role: string; name: string; href: string | null; attempts: number;
  best_likelihood: number | null; last_verdict: 'no_issue_observed' | 'suspect' | 'inconclusive' | null;
  last_observed_result: string | null; blocked_reason: string | null };
export type MemorySnapshot = { version: typeof MEMORY_VERSION; scope_id: string; scope: MemoryScope; prior_runs: number; truncated: boolean;
  pages: Map<string, RememberedPage>; controls: Map<string, RememberedControl>; by_page: Map<string, RememberedControl[]> };

// GET links with secrets, one-time tokens or sign-out semantics are never
// reopened from memory, even though an earlier run observed them.
const SENSITIVE_PARAMETER = /token|code|key|secret|session|auth|pass|sig|otp|nonce|state|ticket|invite|reset|verify|confirm/i;
export function jumpableUrl(raw: string, origin: string): boolean {
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 2048) return false;
  let words: string;
  try { words = decodeURIComponent(url.pathname + ' ' + url.search); } catch { return false; }
  words = words.replace(/[/_?=&.+-]+/g, ' ');
  if (actionRisk(words) || /\b(log|sign)[ -]?(out|off)\b/i.test(words)) return false;
  return ![...url.searchParams.keys()].some(key => SENSITIVE_PARAMETER.test(key));
}

export class AppMemory {
  private constructor(private readonly store: Store, private readonly runId: string, readonly snapshot: MemorySnapshot | null) {}
  static disabled(store: Store, runId: string) { return new AppMemory(store, runId, null); }
  get enabled() { return this.snapshot !== null; }

  // Must run inside the caller's transaction. The snapshot is frozen when the
  // run (or a new sign-in context) starts, so it describes earlier runs only.
  static async open(store: Store, runId: string, scope: MemoryScope) {
    const row = (await store.query(`INSERT INTO app_memory_scopes(scope_id,workspace_id,user_id,origin,viewport_profile,auth_scope,execution_mode,runs,last_run_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,1,$8)
      ON CONFLICT(workspace_id,user_id,origin,viewport_profile,auth_scope,execution_mode) DO UPDATE SET
        runs=app_memory_scopes.runs+CASE WHEN app_memory_scopes.last_run_id IS DISTINCT FROM EXCLUDED.last_run_id THEN 1 ELSE 0 END,
        last_run_id=EXCLUDED.last_run_id,updated_at=now()
      RETURNING scope_id,runs`, [randomUUID(), store.workspaceId, store.userId, scope.origin, scope.viewport_profile, scope.auth_scope, scope.execution_mode, runId])).rows[0];
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
    return new AppMemory(store, runId, { version: MEMORY_VERSION, scope_id: row.scope_id, scope, prior_runs: row.runs - 1,
      truncated: pageRows.length > MAX_PAGES || controlRows.length > MAX_CONTROLS, pages, controls, by_page: byPage });
  }

  summary() {
    const s = this.snapshot;
    return s ? { version: MEMORY_VERSION, enabled: true, scope_id: s.scope_id, ...s.scope, prior_runs: s.prior_runs,
      remembered_pages: s.pages.size, remembered_controls: s.controls.size, snapshot_truncated: s.truncated }
      : { version: MEMORY_VERSION, enabled: false };
  }

  // The writers below are plain statements for the caller's open transaction,
  // so memory commits together with the evidence it was derived from.
  async observe(capture: Capture, pathScore: number) {
    const s = this.snapshot, o = capture.observation;
    if (!s || o.observation_error) return;
    let origin: string;
    try { origin = new URL(o.url).origin; } catch { return; }
    if (origin !== s.scope.origin || o.url.length > 2048) return;
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
