import type { BrowserCommand, Capture, ControlAction } from './contracts.js';
import { blockedReason, type Proposal } from './exploration-policy.js';
import { commandKey } from './interaction-contract.js';

export const PLANNER_VERSION = 'frontier-v1';
export type { BrowserCommand } from './contracts.js';
export type ChangeSignal = { newly_exposed: boolean; changed_pixels: number; sampled_pixels: number };
type Node = {
  id: string; capture: Capture; parent_state_id: string | null; depth: number; reach_estimate: number;
  signals: Record<string, ChangeSignal>; proposals: Map<string, Proposal>; attempted: Set<string>; declined: boolean; focus_stale: boolean;
};
export type RouteStep = {
  from_state_id: string; to_state_id: string; command: BrowserCommand;
  source_action_id: string; expected_result: string; reset?: boolean;
};
export type RankedPath = {
  state_id: string; control_id: string; name: string; goal: string; expected_result: string;
  likelihood: number; path_likelihood_score: number; priority: number; travel_steps: number;
  action?: ControlAction; focus_stale: boolean;
  path_state_ids: string[]; route: RouteStep[];
  components: { likely_next: number; newly_exposed: number; changed_control: number; novelty: number; repeat_penalty: number; reach_weight: number };
  reason: string;
};

// Exact evidence nodes are never merged. This is a bounded scheduling projection
// over those nodes; likelihoods are model hypotheses, not measured user behavior.
export class FrontierPlanner {
  readonly nodes = new Map<string, Node>();
  private readonly edges: RouteStep[] = [];
  private readonly repetitions = new Map<string, number>();
  private readonly returnAttempts = new Map<string, number>();
  private readonly failedRoutes = new Set<string>();
  private root: string | null = null;
  private rootAction: string | null = null;
  constructor(readonly targetUrl: string) {}

  observe(id: string, capture: Capture, parentId?: string, signals: Record<string, ChangeSignal> = {}, likelihood = 1, initial = false) {
    const existing = this.nodes.get(id);
    if (existing) { existing.capture = capture; return existing; }
    const parent = parentId ? this.nodes.get(parentId) : undefined;
    const node: Node = { id, capture, parent_state_id: initial ? null : parentId ?? null,
      depth: initial ? 0 : (parent?.depth ?? -1) + 1,
      reach_estimate: initial ? 1 : (parent?.reach_estimate ?? 1) * likelihood,
      signals, proposals: new Map(), attempted: new Set(), declined: false, focus_stale: false };
    this.nodes.set(id, node);
    if (initial) this.root = id;
    return node;
  }
  metadata(id: string) {
    const node = this.nodes.get(id)!;
    return { algorithm: PLANNER_VERSION, parent_state_id: node.parent_state_id, depth: node.depth,
      path_likelihood_score: node.reach_estimate, probability_calibrated: false };
  }
  available(id: string) {
    const node = this.nodes.get(id)!;
    return (node.capture.observation.controls ?? []).filter(control => !node.attempted.has(control.control_id)
      && !blockedReason(control, new URL(this.targetUrl).origin));
  }
  refocus() {
    // Preserve observed paths/attempted actions. Cached hypotheses may guide a
    // return to another branch, but fresh rankings always take precedence.
    for (const node of this.nodes.values()) { node.focus_stale=true; node.declined=false; }
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
    if (command.type === 'navigate') return;
    const node = this.nodes.get(id)!;
    node.attempted.add(command.control.control_id);
    if (!returning) {
      const key = command.control.control_id;
      this.repetitions.set(key, (this.repetitions.get(key) ?? 0) + 1);
    }
  }
  transition(step: RouteStep, verdict: string, returning?: RouteStep) {
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
  private shortest(from: string, to: string): RouteStep[] | null {
    const queue: { id: string; path: RouteStep[] }[] = [{ id: from, path: [] }], seen = new Set([from]);
    for (let i = 0; i < queue.length; i++) {
      const current = queue[i];
      if (current.id === to) return current.path;
      for (const edge of this.edges) if (edge.from_state_id === current.id && !seen.has(edge.to_state_id) && this.usable(edge)) {
        seen.add(edge.to_state_id); queue.push({ id: edge.to_state_id, path: [...current.path, edge] });
      }
    }
    return null;
  }
  private route(from: string, to: string): RouteStep[] | null {
    const direct = this.shortest(from, to);
    if (!this.root || !this.rootAction || from === this.root) return direct;
    const reset: RouteStep = { from_state_id: from, to_state_id: this.root, source_action_id: this.rootAction,
      command: { type: 'navigate', url: this.targetUrl }, reset: true,
      expected_result: 'The previously observed application entry state becomes visible.' };
    const tail = this.usable(reset) ? this.shortest(this.root, to) : null;
    const viaRoot = tail ? [reset, ...tail] : null;
    return direct && (!viaRoot || direct.length <= viaRoot.length) ? direct : viaRoot;
  }
  private ancestry(id: string) {
    const result: string[] = [], seen = new Set<string>();
    let current: string | null = id;
    while (current && !seen.has(current)) {
      result.unshift(current); seen.add(current); current = this.nodes.get(current)?.parent_state_id ?? null;
    }
    return result;
  }
  rank(currentId: string, remainingActions: number): RankedPath[] {
    const ranked: RankedPath[] = [];
    for (const node of this.nodes.values()) {
      if (node.declined) continue;
      const route = this.route(currentId, node.id);
      // Reserve room for the actual unexplored action after returning.
      if (!route || route.length + 1 > remainingActions) continue;
      for (const control of this.available(node.id)) {
        const proposal = node.proposals.get(control.control_id);
        if (!proposal) continue; // Unranked controls stay explicitly unranked.
        const signal = node.signals[control.control_id];
        const repeats = this.repetitions.get(control.control_id) ?? 0;
        const components = { likely_next: .65 * proposal.likelihood,
          newly_exposed: signal?.newly_exposed ? .15 : 0,
          changed_control: signal && signal.changed_pixels > 0 ? .10 : 0,
          novelty: repeats === 0 ? .10 : 0, repeat_penalty: Math.min(repeats, 3) * .15,
          reach_weight: .6 + .4 * Math.sqrt(node.reach_estimate) };
        const local = Math.max(.01, components.likely_next + components.newly_exposed + components.changed_control + components.novelty - components.repeat_penalty);
        const priority = local * components.reach_weight / (1 + .3 * route.length);
        const reasons = [`Model next-action score ${Math.round(proposal.likelihood * 100)}/100`];
        if (signal?.newly_exposed) reasons.push('newly exposed control');
        if (signal && signal.changed_pixels > 0) reasons.push(`${signal.changed_pixels} changed pixels inside the control`);
        if (node.focus_stale) reasons.push('cached branch awaiting ranking for the current focus');
        if (repeats) reasons.push('repeated control is deprioritized');
        if (route.length) reasons.push(`${route.length} recorded return steps`);
        ranked.push({ state_id: node.id, control_id: control.control_id, name: control.name,
          goal: proposal.goal, expected_result: proposal.expected_result, likelihood: proposal.likelihood, action:proposal.action, focus_stale:node.focus_stale,
          path_likelihood_score: node.reach_estimate * proposal.likelihood, priority,
          travel_steps: route.length, path_state_ids: this.ancestry(node.id), route, components, reason: reasons.join('; ') + '.' });
      }
    }
    return ranked.sort((a,b) => Number(a.focus_stale)-Number(b.focus_stale) || b.priority-a.priority || a.travel_steps-b.travel_steps || a.control_id.localeCompare(b.control_id));
  }
  context(id: string) {
    return { algorithm: PLANNER_VERSION, current_path: this.ancestry(id).map(stateId => {const url=this.nodes.get(stateId)!.capture.observation.url;return {state_id:stateId,url:url.slice(0,240),url_truncated:url.length>240};}),
      discovered_states: this.nodes.size,
      unvisited_controls: [...this.nodes.values()].reduce((n,node) => n+this.available(node.id).length, 0),
      interpretation: 'Model likelihood values are uncalibrated scores, not a normalized distribution; path scores multiply discovery-edge scores. No unobserved destination is invented.' };
  }
}
