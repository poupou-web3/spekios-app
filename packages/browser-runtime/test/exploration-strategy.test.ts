import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_STRATEGY, discoveryReward, MAX_JOURNEY_STEPS, StrategyScheduler, strategySettings, type StrategyMode } from '../src/exploration-strategy.js';

const all = { breadth: { travel_steps: 0 }, depth: { travel_steps: 0 }, rewalk: { travel_steps: 0 } };
// Runs `actions` target actions; a journey step reaches a new screen when `journeys` says so.
function simulate(scheduler: StrategyScheduler, actions: number, reward: (mode: StrategyMode) => number = () => 0, best = all, journeys = false) {
  for (let i = 0; i < actions; i++) {
    const { mode } = scheduler.choose(best)!;
    scheduler.record(mode, { travel: false, reward: reward(mode), newState: journeys, compared: null });
  }
  return scheduler.summary().actions;
}

test('strategy settings are whole percentages that sum to 100 with breadth or depth above zero', () => {
  assert.deepEqual(strategySettings(undefined), DEFAULT_STRATEGY);
  assert.deepEqual(strategySettings(null), DEFAULT_STRATEGY);
  assert.deepEqual(strategySettings({ breadth: 0, depth: 100, rewalk: 0, adaptive: false }), { breadth: 0, depth: 100, rewalk: 0, adaptive: false });
  for (const value of [{ breadth: 50, depth: 30, rewalk: 30, adaptive: true }, { breadth: 0, depth: 0, rewalk: 100, adaptive: true },
    { breadth: 50.5, depth: 29.5, rewalk: 20, adaptive: true }, { breadth: 50, depth: 30, rewalk: 20 }, { breadth: 50, depth: 30, rewalk: 20, adaptive: true, order: 'bfs' },
    { breadth: -10, depth: 90, rewalk: 20, adaptive: true }, [50, 30, 20], 'breadth'])
    assert.throws(() => strategySettings(value), /whole percentages/, JSON.stringify(value));
});

test('fixed shares split the actions like a deficit round-robin', () => {
  const actions = simulate(new StrategyScheduler({ ...DEFAULT_STRATEGY, adaptive: false }), 100);
  assert.deepEqual(actions, { breadth: 50, depth: 30, rewalk: 20 });
  const first = new StrategyScheduler({ ...DEFAULT_STRATEGY, adaptive: false });
  assert.equal(first.choose(all)!.mode, 'breadth', 'Ties go to the largest share.');
});

test('a strategy without candidates gets no turns and no credit; a zero share is off', () => {
  const scheduler = new StrategyScheduler({ ...DEFAULT_STRATEGY, adaptive: false });
  const actions = simulate(scheduler, 80, () => 0, { breadth: { travel_steps: 0 }, depth: { travel_steps: 0 } } as typeof all);
  assert.equal(actions.rewalk, 0);
  assert.deepEqual(actions, { breadth: 50, depth: 30, rewalk: 0 }, 'Breadth and depth split 5:3 while nothing is known to re-walk.');
  const later = simulate(scheduler, 20);
  assert.equal(later.rewalk, 4, 'Re-walking takes its 20% from now on and does not catch up on turns it could not take.');
  const off = new StrategyScheduler({ breadth: 0, depth: 100, rewalk: 0, adaptive: true });
  assert.deepEqual(simulate(off, 10), { breadth: 0, depth: 10, rewalk: 0 });
  assert.equal(off.choose({ breadth: { travel_steps: 0 } }), null);
});

test('adaptive shares follow what each strategy finds but never drop below a quarter', () => {
  const scheduler = new StrategyScheduler(DEFAULT_STRATEGY);
  const actions = simulate(scheduler, 200, mode => mode === 'rewalk' ? 1 : 0);
  assert.ok(actions.rewalk > 40, `A productive strategy earns more turns (${actions.rewalk}).`);
  const shares = scheduler.shares();
  assert.ok(shares.breadth >= .5 * .25 * .99 / (.5 * .25 + .3 * .25 + .2), 'Breadth keeps at least its floor.');
  assert.ok(actions.breadth > 0 && actions.depth > 0);
  assert.ok(scheduler.yieldOf('rewalk') > .8 && scheduler.yieldOf('breadth') < .2);
});

test('a turn continues while travelling and a journey while it keeps reaching new screens nearby', () => {
  const scheduler = new StrategyScheduler({ ...DEFAULT_STRATEGY, adaptive: false });
  assert.equal(scheduler.choose(all)!.mode, 'breadth');
  scheduler.record('breadth', { travel: true, reward: 0, newState: false, compared: null });
  const travelling = scheduler.choose(all)!;
  assert.deepEqual([travelling.mode, travelling.continued], ['breadth', true], 'Travel toward a target keeps the turn.');
  scheduler.record('breadth', { travel: false, reward: 1, newState: true, compared: null });
  const journey = scheduler.choose(all)!;
  assert.deepEqual([journey.mode, journey.continued], ['depth', false], 'One new control ends a breadth turn.');
  for (let step = 1; step < MAX_JOURNEY_STEPS; step++) {
    scheduler.record('depth', { travel: false, reward: 1, newState: true, compared: null });
    assert.equal(scheduler.choose(all)!.mode, 'depth', `Journey step ${step + 1} continues.`);
  }
  scheduler.record('depth', { travel: false, reward: 1, newState: true, compared: null });
  assert.notEqual(scheduler.choose(all)!.mode, 'depth', 'A journey ends after its step limit.');
  assert.equal(scheduler.summary().longest_journey, MAX_JOURNEY_STEPS);

  const stalled = new StrategyScheduler({ breadth: 50, depth: 50, rewalk: 0, adaptive: false });
  stalled.choose(all); stalled.record('breadth', { travel: false, reward: 0, newState: false, compared: null });
  assert.equal(stalled.choose(all)!.mode, 'depth');
  stalled.record('depth', { travel: false, reward: .3, newState: true, compared: null });
  assert.equal(stalled.choose({ ...all, depth: { travel_steps: 2 } })!.mode, 'breadth', 'A journey whose next step needs travel ends.');
  stalled.record('breadth', { travel: false, reward: 0, newState: false, compared: null });
  stalled.choose(all); stalled.record('depth', { travel: false, reward: 0, newState: false, compared: null });
  assert.equal(stalled.choose(all)!.continued, false, 'A journey that reached nothing new ends.');
});

test('discovery rewards value new screens, changed outcomes and suspects', () => {
  assert.equal(discoveryReward({ newState: true, newMapState: true, compared: null, suspect: false }), 1);
  assert.equal(discoveryReward({ newState: true, newMapState: false, compared: null, suspect: false }), .3);
  assert.equal(discoveryReward({ newState: false, newMapState: false, compared: null, suspect: false }), 0);
  assert.equal(discoveryReward({ newState: false, newMapState: false, compared: 'same', suspect: false }), .2);
  assert.equal(discoveryReward({ newState: false, newMapState: false, compared: 'changed', suspect: false }), 1);
  assert.equal(discoveryReward({ newState: false, newMapState: false, compared: null, suspect: true }), .5);
  const scheduler = new StrategyScheduler();
  scheduler.choose(all); scheduler.record('breadth', { travel: false, reward: 1, newState: true, compared: 'changed' });
  assert.deepEqual([scheduler.summary().compared_transitions, scheduler.summary().changed_transitions], [1, 1]);
});
