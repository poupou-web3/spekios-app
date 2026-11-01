import { randomUUID } from 'node:crypto';
import type { BrowserCommand, Capture, ObservedControl } from './contracts.js';
import { blockedReason, type Proposal } from './exploration-policy.js';
import { jumpableUrl } from './app-memory.js';
import type { RouteStep } from './frontier-planner.js';
import type { Store } from './store.js';

// A continuation starts with the graph its stopped run recorded: the same
// states (with their original screenshots), the controls tried and untried on
// each, the model's pending rankings and the transitions that can be used to
// travel back. The copies live in the new run, so continuing a continuation
// carries the whole tree again. Nothing here is new evidence: a copied state
// is matched again only when the new run observes the same fingerprint.
export const CONTINUED_GRAPH_VERSION = 'continued-graph-v1';

export type InheritedState = {
  id: string; capture: Capture; parent_state_id: string | null; depth: number; reach_estimate: number;
  screen_state_id: string | null; map_key: string | null; attempted: string[]; proposals: Proposal[];
};
export type InheritedGraph = {
  source_run_id: string; states: InheritedState[]; routes: RouteStep[];
  root_state_id: string | null; root_action_id: string | null;
  // Where the stopped run last was, to reopen first. Null when that page
  // cannot be opened directly; the run then starts at its entry URL.
  resume: { state_id: string; url: string; action_id: string; title: string | null } | null;
  edges: number;
};

export type StateRow = {
  state_id: string; fingerprint: string; url: string; map_state_key: string | null; page_template: string | null;
  planning: Record<string, any> | null; created_at: string | Date; origin_run_id: string; origin_state_id: string;
  capture_id: string; capture_run_id: string; action_id: string; phase: 'before' | 'after';
  sha256: string | null; object_key: string | null; metadata_key: string | null; byte_length: number | string | null; observation: Capture['observation'] | null;
};
export type FrontierRow = { state_id: string; control_id: string; control: ObservedControl; status: string; reason: string | null; action_id: string | null; planning: Record<string, any> | null };
export type EdgeRow = { from_state_id: string; to_state_id: string; source_run_id: string; source_action_id: string;
  command: BrowserCommand | null; expected_result: string | null; control_key: string | null; routable: boolean };

const ROUTE_COMMANDS = new Set(['navigate', 'click', 'scroll']);

function proposalOf(value: unknown, controlId: string): Proposal | null {
  const p = value as Partial<Proposal> | null;
  if (!p || typeof p !== 'object' || p.control_id !== controlId || typeof p.goal !== 'string' || typeof p.expected_result !== 'string'
    || typeof p.likelihood !== 'number' || !Number.isFinite(p.likelihood) || p.likelihood < 0 || p.likelihood > 1) return null;
  return { control_id: controlId, goal: p.goal, expected_result: p.expected_result, likelihood: p.likelihood, ...(p.action ? { action: p.action } : {}) };
}

// Rebuild the stopped run's graph under new state IDs. States observed in
// another sign-in context than the continuation's are left out, with the
// transitions that touch them. Local blocks (a deferred page, an unresolved
// action) are per run and become untried again; policy blocks stay blocked.
export function rebuildGraph(input: {
  sourceRunId: string; origin: string; authContextId: string | null;
  states: StateRow[]; frontier: FrontierRow[]; edges: EdgeRow[]; lastStateId: string | null;
  purpose: Capture['purpose']; trainingStatus: Capture['training_status']; newId?: () => string;
}) {
  const newId = input.newId ?? randomUUID;
  const ids = new Map<string, string>();
  const kept = input.states.filter(row => row.observation && row.sha256 && row.object_key && row.metadata_key && row.url !== 'about:blank'
    && (row.observation.auth_context_id ?? null) === input.authContextId);
  for (const row of kept) ids.set(row.state_id, newId());
  const mapped = (id: unknown) => typeof id === 'string' ? ids.get(id) ?? null : null;

  const frontier: (FrontierRow & { frontier_id: string })[] = [];
  const attempted = new Map<string, string[]>(), proposals = new Map<string, Proposal[]>();
  for (const row of input.frontier) {
    const stateId = ids.get(row.state_id);
    if (!stateId) continue;
    const policy = blockedReason(row.control, input.origin);
    const status = row.status === 'attempted' ? 'attempted' : policy ? 'blocked' : 'unexplored';
    frontier.push({ ...row, frontier_id: newId(), state_id: stateId, status, reason: status === 'blocked' ? policy : status === 'attempted' ? row.reason : null });
    if (status === 'attempted') attempted.set(stateId, [...(attempted.get(stateId) ?? []), row.control_id]);
    const proposal = proposalOf(row.planning?.proposal, row.control_id);
    if (proposal && status === 'unexplored') proposals.set(stateId, [...(proposals.get(stateId) ?? []), proposal]);
  }

  const states: (InheritedState & { row: StateRow; planning: Record<string, any> })[] = kept.map(row => {
    const planning = row.planning ?? {}, id = ids.get(row.state_id)!;
    const parent = mapped(planning.parent_state_id), screen = mapped(planning.screen_state_id);
    const capture: Capture = { schema_version: 1, capture_id: row.capture_id, run_id: row.capture_run_id, action_id: row.action_id, phase: row.phase,
      sha256: row.sha256!, object_key: row.object_key!, metadata_key: row.metadata_key!, byte_length: Number(row.byte_length ?? 0), observation: row.observation!,
      purpose: input.purpose, training_status: input.trainingStatus };
    const depth = Number.isInteger(planning.depth) && planning.depth >= 0 ? planning.depth : 0;
    const reach = typeof planning.path_likelihood_score === 'number' && planning.path_likelihood_score >= 0 && planning.path_likelihood_score <= 1 ? planning.path_likelihood_score : 1;
    return { id, capture, parent_state_id: parent, depth, reach_estimate: reach, screen_state_id: screen, map_key: row.map_state_key,
      attempted: attempted.get(id) ?? [], proposals: proposals.get(id) ?? [], row,
      planning: { ...planning, parent_state_id: parent, screen_state_id: screen } };
  });

  const edges = input.edges.flatMap((edge, index) => {
    const from = ids.get(edge.from_state_id), to = ids.get(edge.to_state_id);
    return from && to && edge.command ? [{ ...edge, from_state_id: from, to_state_id: to, seq: index + 1 }] : [];
  });
  const routes: RouteStep[] = edges.filter(e => e.routable && e.from_state_id !== e.to_state_id && ROUTE_COMMANDS.has(e.command!.type))
    .map(e => ({ from_state_id: e.from_state_id, to_state_id: e.to_state_id, command: e.command!, source_action_id: e.source_action_id,
      expected_result: e.expected_result ?? 'The previously observed destination appears again.' }));

  // The entry state is the earliest page reached without a parent.
  const root = states.find(s => s.parent_state_id === null && s.depth === 0 && /^https?:/.test(s.capture.observation.url)) ?? null;
  const rootAction = root ? edges.find(e => e.to_state_id === root.id && e.command!.type === 'navigate')?.source_action_id ?? null : null;
  const last = states.find(s => s.id === mapped(input.lastStateId)) ?? null;
  const resume = last && jumpableUrl(last.capture.observation.url, input.origin)
    ? { state_id: last.id, url: last.capture.observation.url, action_id: last.capture.action_id, title: last.capture.observation.title ?? null } : null;
  return { states, frontier, edges, graph: { source_run_id: input.sourceRunId, states, routes, root_state_id: root?.id ?? null,
    root_action_id: rootAction, resume, edges: edges.length } satisfies InheritedGraph };
}

// Must run inside the caller's transaction, before the run records anything.
export async function inheritGraph(store: Store, runId: string, sourceRunId: string, options: {
  origin: string; authContextId: string | null; purpose: Capture['purpose']; trainingStatus: Capture['training_status'];
}): Promise<InheritedGraph> {
  const states = (await store.query(`SELECT s.state_id,s.fingerprint,s.url,s.map_state_key,s.page_template,s.planning,s.created_at,
      COALESCE(s.inherited_from_run_id,s.run_id) AS origin_run_id,COALESCE(s.inherited_from_state_id,s.state_id) AS origin_state_id,
      c.capture_id,c.run_id AS capture_run_id,c.action_id,c.phase,c.sha256,c.object_key,c.metadata_key,c.byte_length,c.observation
    FROM exploration_states s JOIN runtime_captures c ON c.capture_id=s.representative_capture_id
    WHERE s.run_id=$1 ORDER BY s.created_at,s.state_id`, [sourceRunId])).rows as StateRow[];
  const frontier = (await store.query('SELECT state_id,control_id,control,status,reason,action_id,planning FROM exploration_frontier WHERE run_id=$1 ORDER BY state_id,control_id', [sourceRunId])).rows as FrontierRow[];
  // Transitions the stopped run inherited come first, then its own in execution order.
  // Routes settled without a tool, observation or completion failure.
  const edges = (await store.query(`SELECT * FROM (
      SELECT i.from_state_id,i.to_state_id,i.source_run_id,i.source_action_id,i.command,i.expected_result,i.control_key,i.routable,0 AS part,i.seq AS position
        FROM exploration_inherited_edges i WHERE i.run_id=$1
      UNION ALL
      SELECT e.from_state_id,e.to_state_id,e.run_id,e.action_id,a.spec->'command',a.spec->'prediction'->>'expected_result',e.control_key,
        (a.state='completed' AND a.tool_error IS NULL AND a.outcome->>'status'='settled' AND ac.observation IS NOT NULL AND ac.observation->>'observation_error' IS NULL),1,a.ordinal
        FROM exploration_edges e JOIN runtime_actions a ON a.action_id=e.action_id LEFT JOIN runtime_captures ac ON ac.capture_id=a.after_capture_id WHERE e.run_id=$1
    ) edges ORDER BY part,position`, [sourceRunId])).rows as EdgeRow[];
  // The page the stopped run last reached: its latest settled landing, else the
  // last place it inherited.
  const lastStateId = (await store.query(`SELECT e.to_state_id FROM exploration_edges e JOIN runtime_actions a ON a.action_id=e.action_id
      WHERE e.run_id=$1 ORDER BY a.ordinal DESC LIMIT 1`, [sourceRunId])).rows[0]?.to_state_id
    ?? (await store.query("SELECT config->'continued_graph'->>'resume_state_id' AS id FROM runtime_runs WHERE run_id=$1", [sourceRunId])).rows[0]?.id ?? null;

  const rebuilt = rebuildGraph({ sourceRunId, origin: options.origin, authContextId: options.authContextId, states, frontier, edges, lastStateId,
    purpose: options.purpose, trainingStatus: options.trainingStatus });
  if (rebuilt.states.length) await store.query(`INSERT INTO exploration_states(state_id,run_id,representative_capture_id,fingerprint,url,map_state_key,page_template,planning,created_at,inherited_from_run_id,inherited_from_state_id)
    SELECT r.state_id,$1,r.capture_id,r.fingerprint,r.url,r.map_state_key,r.page_template,r.planning,r.created_at,r.origin_run_id,r.origin_state_id
    FROM jsonb_to_recordset($2::jsonb) AS r(state_id uuid,capture_id uuid,fingerprint text,url text,map_state_key text,page_template text,planning jsonb,created_at timestamptz,origin_run_id uuid,origin_state_id uuid)`,
    [runId, JSON.stringify(rebuilt.states.map(s => ({ state_id: s.id, capture_id: s.capture.capture_id, fingerprint: s.row.fingerprint, url: s.row.url,
      map_state_key: s.row.map_state_key, page_template: s.row.page_template, planning: s.planning, created_at: s.row.created_at,
      origin_run_id: s.row.origin_run_id, origin_state_id: s.row.origin_state_id })))]);
  if (rebuilt.frontier.length) await store.query(`INSERT INTO exploration_frontier(frontier_id,run_id,state_id,control_id,control,status,reason,action_id,planning)
    SELECT r.frontier_id,$1,r.state_id,r.control_id,r.control,r.status,r.reason,r.action_id,COALESCE(r.planning,'{}'::jsonb)
    FROM jsonb_to_recordset($2::jsonb) AS r(frontier_id uuid,state_id uuid,control_id text,control jsonb,status text,reason text,action_id uuid,planning jsonb)`,
    [runId, JSON.stringify(rebuilt.frontier)]);
  if (rebuilt.edges.length) await store.query(`INSERT INTO exploration_inherited_edges(run_id,from_state_id,to_state_id,source_run_id,source_action_id,seq,command,expected_result,control_key,routable)
    SELECT $1,r.from_state_id,r.to_state_id,r.source_run_id,r.source_action_id,r.seq,r.command,COALESCE(r.expected_result,''),r.control_key,r.routable
    FROM jsonb_to_recordset($2::jsonb) AS r(from_state_id uuid,to_state_id uuid,source_run_id uuid,source_action_id uuid,seq int,command jsonb,expected_result text,control_key text,routable boolean)
    ON CONFLICT (run_id,source_action_id) DO NOTHING`, [runId, JSON.stringify(rebuilt.edges)]);
  return rebuilt.graph;
}
