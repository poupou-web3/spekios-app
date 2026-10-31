// A run's actions are shared between three strategies: new territory
// (breadth), deep journeys (depth) and re-walking transitions earlier runs
// recorded (rewalk). Each has a share. The strategy furthest below its share
// takes the next turn, like a deficit round-robin scheduler. A turn ends when
// its strategy has done what it set out to: one new control, one known
// transition, or a whole journey. Travel to reach the target counts toward
// the strategy that asked for it.
//
// Shares adapt to what each strategy finds. Its yield is a decayed mean of
// per-action discovery rewards; a strategy that stops finding anything keeps
// a quarter of its share, so none is starved by an early streak.
export const STRATEGY_VERSION = 'strategy-v1';
export const STRATEGY_MODES = ['breadth', 'depth', 'rewalk'] as const;
export type StrategyMode = typeof STRATEGY_MODES[number];
export type StrategySettings = Record<StrategyMode, number> & { adaptive: boolean };
// Whole percentages that sum to 100. Zero turns a strategy off.
export const DEFAULT_STRATEGY: StrategySettings = { breadth: 50, depth: 30, rewalk: 20, adaptive: true };
export const MAX_JOURNEY_STEPS = 12;
const FLOOR = .25, DECAY = .8, PRIOR_MEAN = .5, PRIOR_WEIGHT = 2;

export function strategySettings(value: unknown): StrategySettings {
  if (value === undefined || value === null) return DEFAULT_STRATEGY;
  const v = value as Record<string, unknown>;
  if (typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join(',') !== 'adaptive,breadth,depth,rewalk' || typeof v.adaptive !== 'boolean'
    || !STRATEGY_MODES.every(m => Number.isInteger(v[m]) && (v[m] as number) >= 0 && (v[m] as number) <= 100)
    || STRATEGY_MODES.reduce((sum, m) => sum + (v[m] as number), 0) !== 100 || (v.breadth as number) + (v.depth as number) === 0)
    throw new Error('The exploration strategy needs whole percentages for breadth, depth and rewalk that sum to 100, with breadth or depth above zero.');
  return { breadth: v.breadth as number, depth: v.depth as number, rewalk: v.rewalk as number, adaptive: v.adaptive };
}

// Discovery value of one executed action, from 0 to 1. A screen no run of
// this app has reached is worth most; a difference from what earlier runs
// observed for the same action is worth as much; a suspect adds to either.
export function discoveryReward(o: { newState: boolean; newMapState: boolean; compared: 'same' | 'changed' | null; suspect: boolean }) {
  let reward = o.newMapState ? 1 : o.newState ? .3 : 0;
  if (o.compared === 'changed') reward = 1;
  else if (o.compared === 'same') reward = Math.max(reward, .2);
  return Math.min(1, reward + (o.suspect ? .5 : 0));
}

type PerMode = Record<StrategyMode, number>;
const zero = (): PerMode => ({ breadth: 0, depth: 0, rewalk: 0 });
export type Best = Partial<Record<StrategyMode, { travel_steps: number }>>;
type Turn = { mode: StrategyMode; steps: number; traveling: boolean; open: boolean };

export class StrategyScheduler {
  private readonly credit = zero(); private readonly spent = zero(); private readonly turns = zero();
  private readonly decayed = zero(); private readonly weight = zero(); private readonly rewards = zero();
  private available: StrategyMode[] = [];
  private turn: Turn | null = null;
  private longestJourney = 0;
  private compared = 0; private changed = 0;
  constructor(readonly settings: StrategySettings = DEFAULT_STRATEGY) {}

  yieldOf(mode: StrategyMode) {
    return (PRIOR_MEAN * PRIOR_WEIGHT + this.decayed[mode]) / (PRIOR_WEIGHT + this.weight[mode]);
  }
  // Effective shares among the strategies that have something to do.
  shares(available: readonly StrategyMode[] = STRATEGY_MODES): PerMode {
    const enabled = available.filter(m => this.settings[m] > 0);
    const best = Math.max(0, ...enabled.map(m => this.yieldOf(m)));
    const raw = zero();
    for (const m of enabled) raw[m] = this.settings[m] * (this.settings.adaptive && best > 0 ? FLOOR + (1 - FLOOR) * this.yieldOf(m) / best : 1);
    const total = raw.breadth + raw.depth + raw.rewalk;
    for (const m of STRATEGY_MODES) raw[m] = total ? raw[m] / total : 0;
    return raw;
  }
  private decide(best: Best) {
    const available = STRATEGY_MODES.filter(m => best[m] && this.settings[m] > 0);
    if (!available.length) return null;
    const t = this.turn;
    // A turn continues before its first action, while travelling to its
    // target, and for a journey while it keeps reaching new screens nearby.
    if (t?.open && available.includes(t.mode) && (t.steps === 0 || t.traveling || t.mode === 'depth' && best.depth!.travel_steps === 0))
      return { mode: t.mode, continued: true, available };
    const deficit = (m: StrategyMode) => this.credit[m] - this.spent[m];
    const mode = [...available].sort((a, b) => deficit(b) - deficit(a) || this.settings[b] - this.settings[a])[0];
    return { mode, continued: false, available };
  }
  // The strategy that would take the next action, without starting a turn.
  peek(best: Best) { return this.decide(best)?.mode ?? null; }
  choose(best: Best) {
    const decision = this.decide(best);
    if (!decision) return null;
    this.available = decision.available;
    if (!decision.continued) { this.turn = { mode: decision.mode, steps: 0, traveling: false, open: true }; this.turns[decision.mode]++; }
    return { mode: decision.mode, continued: decision.continued, turn: this.turns[decision.mode], shares: this.shares(decision.available) };
  }
  // Called once per executed action of the chosen strategy.
  record(mode: StrategyMode, outcome: { travel: boolean; reward: number; newState: boolean; compared: 'same' | 'changed' | null }) {
    const shares = this.shares(this.available);
    for (const m of this.available) this.credit[m] += shares[m];
    this.spent[mode]++;
    this.decayed[mode] = this.decayed[mode] * DECAY + outcome.reward;
    this.weight[mode] = this.weight[mode] * DECAY + 1;
    this.rewards[mode] += outcome.reward;
    if (outcome.compared) { this.compared++; if (outcome.compared === 'changed') this.changed++; }
    const t = this.turn;
    if (!t || t.mode !== mode) return;
    t.steps++;
    t.traveling = outcome.travel;
    if (!outcome.travel) t.open = mode === 'depth' && outcome.newState && t.steps < MAX_JOURNEY_STEPS;
    if (mode === 'depth') this.longestJourney = Math.max(this.longestJourney, t.steps);
  }
  // A compact view for each selection record.
  state() {
    const round = (n: number) => Math.round(n * 1000) / 1000;
    const per = (f: (m: StrategyMode) => number) => Object.fromEntries(STRATEGY_MODES.map(m => [m, round(f(m))])) as PerMode;
    return { shares: per(m => this.shares(this.available.length ? this.available : STRATEGY_MODES)[m]), actions: { ...this.spent },
      yield: per(m => this.yieldOf(m)), deficit: per(m => this.credit[m] - this.spent[m]) };
  }
  summary() {
    return { version: STRATEGY_VERSION, settings: this.settings, ...this.state(), turns: { ...this.turns },
      reward_total: Object.fromEntries(STRATEGY_MODES.map(m => [m, Math.round(this.rewards[m] * 100) / 100])),
      longest_journey: this.longestJourney, compared_transitions: this.compared, changed_transitions: this.changed };
  }
}
