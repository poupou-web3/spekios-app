import type { BrowserCommand, Capture, ControlAction, ObservedControl } from './contracts.js';
import { blockedReason, type Proposal } from './exploration-policy.js';
import { commandAction, commandFor, commandKey } from './interaction-contract.js';
import { jumpableUrl, type MapTransition, type MemorySnapshot } from './app-memory.js';
import { controlEntry, pageTemplate, transitionKey } from './app-map.js';
import type { StrategyMode } from './exploration-strategy.js';

export const PLANNER_VERSION = 'frontier-v3';
// A remembered page whose controls were observed but never ranked by a model.
export const UNRANKED_MEMORY_SCORE = .3;
// Actions one top-level area may take before new territory starts sharing
// the budget with other areas, and the depth preference per level.
export const BRANCH_SLACK = 6;
const DEPTH_BONUS = .25;
export type { BrowserCommand } from './contracts.js';
export type ChangeSignal = { newly_exposed: boolean; changed_pixels: number; sampled_pixels: number };
type Node = {
  id: string; capture: Capture; parent_state_id: string | null; depth: number; reach_estimate: number;
  signals: Record<string, ChangeSignal>; proposals: Map<string, Proposal>; attempted: Set<string>; declined: boolean; focus_stale: boolean;
  // App-map identity of the screen and of each control on it (http pages only).
  map_key: string | null; entries: Map<string, string>;
};
export type RouteStep = {
  from_state_id: string; to_state_id: string; command: BrowserCommand;
  source_action_id: string; expected_result: string; reset?: boolean;
  // Reopens a page remembered from earlier runs. Its destination is a new
  // observation in this run, never an assumed restored state.
  memory?: { url: string; title: string | null; open_controls: number; source_run_id: string };
};
export type RankedPath = {
  state_id: string; control_id: string; name: string; goal: string; expected_result: string;
  likelihood: number; path_likelihood_score: number; priority: number; travel_steps: number;
  action?: ControlAction; focus_stale: boolean;
  path_state_ids: string[]; route: RouteStep[];
  components: { likely_next: number; newly_exposed: number; changed_control: number; novelty: number; repeat_penalty: number;
    earlier_run_coverage: number; new_since_earlier_runs: number; repeated_entry: number; map_coverage: number; reach_weight: number };
  reason: string;
  // How the run's strategy weighed this path; priority already includes it.
  strategy?: { mode: StrategyMode; factor: number; branch_state_id?: string | null; branch_actions?: number; fair_share?: number; depth?: number };
  // A transition earlier runs recorded, repeated to compare its outcome.
  rewalk?: { from_key: string; control_key: string; known_to_keys: string[]; attempts: number; last_verdict: string | null };
  // A return to a screen whose remaining controls the model has not ranked.
  unranked?: number;
};
export type EarlierOutcome = { known_to_keys: string[]; attempts: number; last_verdict: string | null; last_observed_result: string | null };
const ZERO = { likely_next: 0, newly_exposed: 0, changed_control: 0, novelty: 0, repeat_penalty: 0, earlier_run_coverage: 0,
  new_since_earlier_runs: 0, repeated_entry: 0, map_coverage: 0 };

// Exact evidence nodes are never merged. This is a bounded scheduling projection
// over those nodes; likelihoods are model hypotheses, not measured user behavior.
// Memory from earlier runs is keyed by URL and control identity only.
export class FrontierPlanner {
  readonly nodes = new Map<string, Node>();
  private readonly edges: RouteStep[] = [];
  private readonly repetitions = new Map<string, number>();
  private readonly returnAttempts = new Map<string, number>();
  private readonly failedRoutes = new Set<string>();
  private readonly navigated = new Set<string>();
  private root: string | null = null;
  private rootAction: string | null = null;
  private focused = false;
  // Map states reached and entries acted on in this run, and actions spent
  // in each top-level area (keyed by its depth-1 state, or 'root').
  private readonly mapSeen = new Set<string>();
  private readonly entriesTried = new Set<string>();
  private readonly walked = new Set<string>();
  private readonly branchSpent = new Map<string, number>();
  constructor(readonly targetUrl: string, readonly memory: MemorySnapshot | null = null) {}

  observe(id: string, capture: Capture, parentId?: string, signals: Record<string, ChangeSignal> = {}, likelihood = 1, initial = false, mapKey: string | null = null) {
    const existing = this.nodes.get(id);
    if (existing) { existing.capture = capture; return existing; }
    const parent = parentId ? this.nodes.get(parentId) : undefined;
    const entries = new Map<string, string>();
    if (mapKey) for (const control of capture.observation.controls ?? []) if (control.role !== 'scroll') entries.set(control.control_id, controlEntry(control).key);
    const node: Node = { id, capture, parent_state_id: initial ? null : parentId ?? null,
      depth: initial ? 0 : (parent?.depth ?? -1) + 1,
      reach_estimate: initial ? 1 : (parent?.reach_estimate ?? 1) * likelihood,
      signals, proposals: new Map(), attempted: new Set(), declined: false, focus_stale: false, map_key: mapKey, entries };
    this.nodes.set(id, node);
    if (mapKey) this.mapSeen.add(mapKey);
    if (initial) this.root = id;
    return node;
  }
  // Whether this run or an earlier one already reached an equivalent screen.
  mapKnown(key: string) {
    return this.mapSeen.has(key) || !!this.memory?.map?.states.has(key);
  }
  // What earlier runs observed for this action on an equivalent screen.
  earlier(fromKey: string, command: BrowserCommand): EarlierOutcome | null {
    const key = transitionKey(command).key;
    const rows = this.memory?.map?.transitions.get(fromKey)?.filter(t => t.control_key === key);
    if (!rows?.length) return null;
    return { known_to_keys: [...new Set(rows.map(t => t.to_key))], attempts: rows.reduce((n, t) => n + t.attempts, 0),
      last_verdict: rows[0].last_verdict, last_observed_result: rows[0].last_observed_result };
  }
  metadata(id: string) {
    const node = this.nodes.get(id)!;
    return { algorithm: PLANNER_VERSION, parent_state_id: node.parent_state_id, depth: node.depth,
      path_likelihood_score: node.reach_estimate, probability_calibrated: false };
  }
  available(id: string) {
    const node = this.nodes.get(id)!;
    return (node.capture.observation.controls ?? []).filter(control => !node.attempted.has(control.control_id)
      && !this.memory?.withheld?.has(control.control_id) && !blockedReason(control, new URL(this.targetUrl).origin));
  }
  refocus() {
    // Preserve observed paths/attempted actions. Cached hypotheses may guide a
    // return to another branch, but fresh rankings always take precedence.
    for (const node of this.nodes.values()) { node.focus_stale=true; node.declined=false; }
    this.focused = true;
  }
  plan(id: string, proposals: Proposal[]) {
    const node = this.nodes.get(id)!;
    node.declined = proposals.length === 0;
    node.focus_stale=false;
    // A fresh decision replaces this state's older hypotheses. Other states
    // keep their cached frontiers until we return and observe them again.
    node.proposals = new Map(proposals.map(proposal => [proposal.control_id, proposal]));
  }
  attempted(id: string, command: BrowserCommand, returning: boolean) {
    if (command.type === 'navigate') { this.navigated.add(command.url); return; }
    const node = this.nodes.get(id)!;
    node.attempted.add(command.control.control_id);
    if (node.map_key) {
      this.entriesTried.add(`${node.map_key}|${node.entries.get(command.control.control_id) ?? controlEntry(command.control).key}`);
      this.walked.add(`${node.map_key}|${transitionKey(command).key}`);
    }
    if (!returning) {
      const key = command.control.control_id;
      this.repetitions.set(key, (this.repetitions.get(key) ?? 0) + 1);
    }
  }
  transition(step: RouteStep, verdict: string, returning?: RouteStep) {
    const from = this.nodes.get(step.from_state_id);
    if (from) { const area = this.branchOf(from) ?? 'root'; this.branchSpent.set(area, (this.branchSpent.get(area) ?? 0) + 1); }
    if (returning) {
      const key = this.routeKey(returning);
      this.returnAttempts.set(key, (this.returnAttempts.get(key) ?? 0) + 1);
      if (step.to_state_id !== returning.to_state_id || verdict !== 'no_issue_observed') this.failedRoutes.add(key);
    }
    if (verdict !== 'no_issue_observed') return;
    if (step.command.type === 'navigate' && step.to_state_id === this.root && !this.rootAction) this.rootAction = step.source_action_id;
    if (step.from_state_id !== step.to_state_id && !this.edges.some(e => this.routeKey(e) === this.routeKey(step))) this.edges.push(step);
  }
  private routeKey(step: RouteStep) {
    return `${step.from_state_id}:${step.to_state_id}:${commandKey(step.command)}`;
  }
  private usable(step: RouteStep) {
    const key = this.routeKey(step);
    return !this.failedRoutes.has(key) && (this.returnAttempts.get(key) ?? 0) < 2;
  }
  // Shortest recorded routes from one state to every state it reaches, in
  // one breadth-first pass over the usable edges.
  private reach(from: string): Map<string, RouteStep[]> {
    const out = new Map<string, RouteStep[]>();
    for (const edge of this.edges) if (this.usable(edge)) out.set(edge.from_state_id, [...(out.get(edge.from_state_id) ?? []), edge]);
    const paths = new Map<string, RouteStep[]>([[from, []]]), queue = [from];
    for (let i = 0; i < queue.length; i++) {
      const path = paths.get(queue[i])!;
      for (const edge of out.get(queue[i]) ?? []) if (!paths.has(edge.to_state_id)) { paths.set(edge.to_state_id, [...path, edge]); queue.push(edge.to_state_id); }
    }
    return paths;
  }
  // A direct route, or a reset to the entry state and a route from there.
  private routes(from: string): (to: string) => RouteStep[] | null {
    const direct = this.reach(from);
    if (!this.root || !this.rootAction || from === this.root) return to => direct.get(to) ?? null;
    const reset: RouteStep = { from_state_id: from, to_state_id: this.root, source_action_id: this.rootAction,
      command: { type: 'navigate', url: this.targetUrl }, reset: true,
      expected_result: 'The previously observed application entry state becomes visible.' };
    const fromRoot = this.usable(reset) ? this.reach(this.root) : new Map<string, RouteStep[]>();
    return to => {
      const path = direct.get(to) ?? null, tail = fromRoot.get(to), viaRoot = tail ? [reset, ...tail] : null;
      return path && (!viaRoot || path.length <= viaRoot.length) ? path : viaRoot;
    };
  }
  // The top-level area a state belongs to: its depth-1 ancestor.
  private branchOf(node: Node): string | null {
    return node.depth === 0 ? null : this.ancestry(node.id)[1] ?? node.id;
  }
  // New territory keeps each top-level area near a fair share of the actions
  // spent so far, with some slack so short runs are not forced to bounce.
  private balance() {
    const total = [...this.branchSpent.values()].reduce((n, v) => n + v, 0);
    const areas = 1 + [...this.nodes.values()].filter(n => n.depth === 1).length + (this.root && this.nodes.has(this.root) ? this.available(this.root).length : 0);
    return { fair: Math.max(BRANCH_SLACK, total / areas) };
  }
  private weigh(path: RankedPath, node: Node, mode: StrategyMode | undefined, fair: number): RankedPath {
    if (mode === 'breadth') {
      const branch = this.branchOf(node), spent = branch ? this.branchSpent.get(branch) ?? 0 : 0;
      const factor = spent > fair ? fair / spent : 1;
      if (factor < 1) path.reason = path.reason.replace(/\.$/, `; its area already took ${spent} actions (fair share ${Math.round(fair)}).`);
      return { ...path, priority: path.priority * factor, strategy: { mode, factor, branch_state_id: branch, branch_actions: spent, fair_share: Math.round(fair * 100) / 100 } };
    }
    if (mode === 'depth') {
      const factor = (1 + DEPTH_BONUS * node.depth) / (1 + path.travel_steps);
      return { ...path, priority: path.priority * factor, strategy: { mode, factor, depth: node.depth } };
    }
    return path;
  }
  private sorted(ranked: RankedPath[]) {
    return ranked.sort((a,b) => Number(a.focus_stale)-Number(b.focus_stale) || b.priority-a.priority || a.travel_steps-b.travel_steps || a.control_id.localeCompare(b.control_id));
  }
  private ancestry(id: string) {
    const result: string[] = [], seen = new Set<string>();
    let current: string | null = id;
    while (current && !seen.has(current)) {
      result.unshift(current); seen.add(current); current = this.nodes.get(current)?.parent_state_id ?? null;
    }
    return result;
  }
  // Without a mode this is the plain frontier ranking. With one it is that
  // strategy's view: new territory balances top-level areas and returns to
  // screens with unranked controls, a journey prefers deeper screens nearby,
  // and a re-walk lists transitions earlier runs recorded.
  rank(currentId: string, remainingActions: number, mode?: StrategyMode): RankedPath[] {
    const routeTo = this.routes(currentId);
    if (mode === 'rewalk') return this.sorted(this.rewalks(routeTo, remainingActions));
    const ranked: RankedPath[] = [];
    const { fair } = this.balance();
    for (const node of this.nodes.values()) {
      if (node.declined) continue;
      const route = routeTo(node.id);
      // Reserve room for the actual unexplored action after returning.
      if (!route || route.length + 1 > remainingActions) continue;
      const page = this.memory?.pages.get(node.capture.observation.url);
      const available = this.available(node.id);
      for (const control of available) {
        const proposal = node.proposals.get(control.control_id);
        if (!proposal) continue; // Unranked controls stay explicitly unranked.
        const signal = node.signals[control.control_id];
        const repeats = this.repetitions.get(control.control_id) ?? 0;
        const earlier = this.memory?.controls.get(control.control_id);
        const entry = node.map_key ? `${node.map_key}|${node.entries.get(control.control_id)}` : null;
        const components = { likely_next: .65 * proposal.likelihood,
          newly_exposed: signal?.newly_exposed ? .15 : 0,
          changed_control: signal && signal.changed_pixels > 0 ? .10 : 0,
          novelty: repeats === 0 && !earlier?.attempts ? .10 : 0, repeat_penalty: Math.min(repeats, 3) * .15,
          earlier_run_coverage: earlier?.attempts ? earlier.last_verdict === 'no_issue_observed' ? .20 : .10 : 0,
          new_since_earlier_runs: page && !page.controls_truncated && !earlier ? .10 : 0,
          // Another item of the same list, or the same control on an equivalent screen.
          repeated_entry: !repeats && entry && this.entriesTried.has(entry) ? .20 : 0,
          map_coverage: !earlier?.attempts && entry && this.memory?.map?.tried.has(entry) ? .20 : 0,
          reach_weight: .6 + .4 * Math.sqrt(node.reach_estimate) };
        const local = Math.max(.01, components.likely_next + components.newly_exposed + components.changed_control + components.novelty
          + components.new_since_earlier_runs - components.repeat_penalty - components.earlier_run_coverage - components.repeated_entry - components.map_coverage);
        const priority = local * components.reach_weight / (1 + .3 * route.length);
        const reasons = [`Model next-action score ${Math.round(proposal.likelihood * 100)}/100`];
        if (signal?.newly_exposed) reasons.push('newly exposed control');
        if (signal && signal.changed_pixels > 0) reasons.push(`${signal.changed_pixels} changed pixels inside the control`);
        if (control.in_viewport === false) reasons.push('below the visible area; scrolled into view before acting');
        if (node.focus_stale) reasons.push('cached branch awaiting ranking for the current focus');
        if (repeats) reasons.push('repeated control is deprioritized');
        if (earlier?.attempts) reasons.push(`already tried in earlier runs (last: ${earlier.last_verdict?.replaceAll('_', ' ') ?? 'no assessment'})`);
        if (components.new_since_earlier_runs) reasons.push('not seen on this page in earlier runs');
        if (components.repeated_entry) reasons.push('an equivalent control was already tried on an equivalent screen in this run');
        if (components.map_coverage) reasons.push('tried on an equivalent screen in earlier runs');
        if (route.length) reasons.push(`${route.length} recorded return steps`);
        ranked.push(this.weigh({ state_id: node.id, control_id: control.control_id, name: control.name,
          goal: proposal.goal, expected_result: proposal.expected_result, likelihood: proposal.likelihood, action:proposal.action, focus_stale:node.focus_stale,
          path_likelihood_score: node.reach_estimate * proposal.likelihood, priority,
          travel_steps: route.length, path_state_ids: this.ancestry(node.id), route, components, reason: reasons.join('; ') + '.' }, node, mode, fair));
      }
      // The model ranks at most eight controls per request. New territory
      // returns to a screen to rank the rest once it has moved on.
      const unranked = mode === 'breadth' && route.length ? available.filter(c => !node.proposals.has(c.control_id)) : [];
      if (unranked.length) {
        const components = { ...ZERO, likely_next: .65 * UNRANKED_MEMORY_SCORE, novelty: .10, reach_weight: .6 + .4 * Math.sqrt(node.reach_estimate) };
        ranked.push(this.weigh({ state_id: node.id, control_id: unranked[0].control_id, name: unranked[0].name,
          goal: `Rank ${unranked.length} more controls on this screen`, expected_result: route.at(-1)!.expected_result, likelihood: UNRANKED_MEMORY_SCORE,
          path_likelihood_score: node.reach_estimate * UNRANKED_MEMORY_SCORE, focus_stale: node.focus_stale,
          priority: (components.likely_next + components.novelty) * components.reach_weight / (1 + .3 * route.length),
          travel_steps: route.length, path_state_ids: this.ancestry(node.id), route, components, unranked: unranked.length,
          reason: `${unranked.length} controls here have not been ranked yet (default score ${Math.round(UNRANKED_MEMORY_SCORE * 100)}/100); return and rank them; ${route.length} recorded return steps.` }, node, mode, fair));
      }
    }
    ranked.push(...this.remembered(currentId, remainingActions, mode));
    return this.sorted(ranked);
  }
  // Transitions earlier runs recorded from screens equivalent to ones this
  // run reached, repeated to compare where they lead and what they show now.
  private rewalks(routeTo: (to: string) => RouteStep[] | null, remainingActions: number): RankedPath[] {
    const map = this.memory?.map;
    if (!map) return [];
    const result: RankedPath[] = [];
    for (const node of this.nodes.values()) {
      const known = node.map_key ? map.transitions.get(node.map_key) : undefined;
      if (!known?.length) continue;
      const route = routeTo(node.id);
      if (!route || route.length + 1 > remainingActions) continue;
      const byEntry = new Map<string, ObservedControl[]>();
      for (const control of this.available(node.id)) {
        const entry = node.entries.get(control.control_id);
        if (entry) byEntry.set(entry, [...(byEntry.get(entry) ?? []), control]);
      }
      const groups = new Map<string, MapTransition[]>();
      for (const t of known) groups.set(t.control_key, [...(groups.get(t.control_key) ?? []), t]);
      for (const [controlKey, rows] of groups) {
        const latest = rows[0], action = rewalkAction(latest);
        if (!action || !latest.entry_key || this.walked.has(`${node.map_key}|${controlKey}`)) continue;
        let command: BrowserCommand | undefined;
        for (const control of byEntry.get(latest.entry_key) ?? []) {
          try { const candidate = commandFor(control, action); if (transitionKey(candidate).key === controlKey) { command = candidate; break; } } catch { /* Not usable this way now. */ }
        }
        if (!command || command.type === 'navigate') continue;
        const destinations = [...new Set(rows.map(t => t.to_key))];
        const flagged = rows.some(t => t.last_verdict && t.last_verdict !== 'no_issue_observed');
        const value = .5 + (flagged ? .3 : 0) + (destinations.length > 1 ? .2 : 0), reach = .6 + .4 * Math.sqrt(node.reach_estimate);
        const reasons = [`Re-walk a transition earlier runs recorded ${rows.reduce((n, t) => n + t.attempts, 0)} times`];
        if (flagged) reasons.push('an earlier outcome was suspect or inconclusive');
        if (destinations.length > 1) reasons.push(`it led to ${destinations.length} different screens before`);
        if (route.length) reasons.push(`${route.length} recorded return steps`);
        result.push({ state_id: node.id, control_id: command.control.control_id, name: command.control.name, goal: `Re-walk ${command.control.name}`,
          expected_result: latest.last_observed_result ?? 'The result earlier runs observed appears again.', likelihood: .5,
          path_likelihood_score: node.reach_estimate * .5, priority: value * reach / (1 + .3 * route.length), travel_steps: route.length,
          action: commandAction(command), focus_stale: node.focus_stale, path_state_ids: this.ancestry(node.id), route,
          components: { ...ZERO, reach_weight: reach }, reason: reasons.join('; ') + '.', strategy: { mode: 'rewalk', factor: value },
          rewalk: { from_key: node.map_key!, control_key: controlKey, known_to_keys: destinations, attempts: rows.reduce((n, t) => n + t.attempts, 0), last_verdict: latest.last_verdict } });
      }
    }
    return result;
  }
  // Pages that earlier runs reached but did not finish. Reopening one costs a
  // navigation plus at least one action there. A remembered page is never
  // treated as an observed state: the run plans again once it lands.
  private remembered(currentId: string, remainingActions: number, mode?: StrategyMode): RankedPath[] {
    const memory = this.memory;
    if (!memory || !this.root || remainingActions < 2) return [];
    const origin = new URL(this.targetUrl).origin;
    const visited = new Set([...this.nodes.values()].map(node => node.capture.observation.url));
    const result: RankedPath[] = [];
    for (const page of memory.pages.values()) {
      if (visited.has(page.url) || this.navigated.has(page.url) || page.url === this.targetUrl || !jumpableUrl(page.url, origin)) continue;
      const open = (memory.by_page.get(page.url) ?? []).filter(c => !c.attempts && !c.blocked_reason);
      if (!open.length) continue;
      const best = [...open].sort((a, b) => (b.best_likelihood ?? -1) - (a.best_likelihood ?? -1) || a.control_id.localeCompare(b.control_id))[0];
      const likelihood = best.best_likelihood ?? UNRANKED_MEMORY_SCORE;
      const reach = page.best_path_score ?? 0;
      const components = { ...ZERO, likely_next: .65 * likelihood, novelty: .10, reach_weight: .6 + .4 * Math.sqrt(reach) };
      // A journey resumes deeper pages first, by their depth in the app map.
      const depth = this.memory?.map?.depth_by_template.get(pageTemplate(page.url)) ?? 1;
      const factor = mode === 'depth' ? (1 + DEPTH_BONUS * depth) / 2 : 1;
      const priority = (components.likely_next + components.novelty) * components.reach_weight / 1.3 * factor;
      const step: RouteStep = { from_state_id: currentId, to_state_id: `memory:${page.url}`, command: { type: 'navigate', url: page.url },
        source_action_id: page.last_action_id ?? '', expected_result: `The previously observed page${page.title ? ` "${page.title}"` : ''} opens.`,
        memory: { url: page.url, title: page.title, open_controls: open.length, source_run_id: page.last_run_id } };
      result.push({ state_id: step.to_state_id, control_id: best.control_id, name: best.name,
        goal: `Resume ${best.name} on a page earlier runs did not finish`, expected_result: step.expected_result, likelihood,
        path_likelihood_score: reach * likelihood, priority, travel_steps: 1, focus_stale: this.focused, path_state_ids: [], route: [step], components,
        ...(mode === 'depth' ? { strategy: { mode, factor, depth } } : mode === 'breadth' ? { strategy: { mode, factor: 1 } } : {}),
        reason: [best.best_likelihood === null ? `Unranked remembered page (default score ${Math.round(UNRANKED_MEMORY_SCORE * 100)}/100)`
          : `Earlier model next-action score ${Math.round(likelihood * 100)}/100`, `${open.length} untried controls remembered from ${memory.prior_runs} earlier run${memory.prior_runs === 1 ? '' : 's'}`,
          'reopen the page; it is observed again before any action'].join('; ') + '.' });
    }
    return result;
  }
  // Coverage at each depth of this run's discovery tree: screens reached and
  // their usable controls tried. Blocked controls are counted separately.
  coverage() {
    const origin = new URL(this.targetUrl).origin, levels = new Map<number, { depth: number; states: number; controls: number; tried: number; blocked: number }>();
    for (const node of this.nodes.values()) {
      if (!/^https?:/.test(node.capture.observation.url)) continue;
      const level = levels.get(node.depth) ?? { depth: node.depth, states: 0, controls: 0, tried: 0, blocked: 0 };
      level.states++;
      for (const control of node.capture.observation.controls ?? []) {
        if (control.role === 'scroll') continue;
        if (node.attempted.has(control.control_id)) { level.controls++; level.tried++; }
        else if (blockedReason(control, origin)) level.blocked++;
        else level.controls++;
      }
      levels.set(node.depth, level);
    }
    return [...levels.values()].sort((a, b) => a.depth - b.depth)
      .map(l => ({ ...l, coverage: l.controls ? Math.round(l.tried / l.controls * 1000) / 1000 : 1 }));
  }
  context(id: string) {
    return { algorithm: PLANNER_VERSION, current_path: this.ancestry(id).map(stateId => {const url=this.nodes.get(stateId)!.capture.observation.url;return {state_id:stateId,url:url.slice(0,240),url_truncated:url.length>240};}),
      discovered_states: this.nodes.size,
      unvisited_controls: [...this.nodes.values()].reduce((n,node) => n+this.available(node.id).length, 0),
      ...(this.memory?.prior_runs ? { remembered_pages: this.memory.pages.size } : {}),
      interpretation: 'Model likelihood values are uncalibrated scores, not a normalized distribution; path scores multiply discovery-edge scores. No unobserved destination is invented.' };
  }
}

// Actions a later run can repeat exactly. Typed text is not kept in the map.
function rewalkAction(t: MapTransition): ControlAction | null {
  switch (t.action) {
    case 'click': case 'submit': return { type: t.action };
    case 'select': return typeof t.control.choice === 'string' ? { type: 'select', value: t.control.choice } : null;
    case 'set_checked': return typeof t.control.choice === 'boolean' ? { type: 'set_checked', checked: t.control.choice } : null;
    default: return null;
  }
}
