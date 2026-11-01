import test from 'node:test';
import assert from 'node:assert/strict';
import { rebuildGraph, type EdgeRow, type FrontierRow, type StateRow } from '../src/continued-graph.js';
import { FrontierPlanner, type BrowserCommand } from '../src/frontier-planner.js';
import type { ObservedControl } from '../src/contracts.js';

// Pure tests: the stopped run's rows are given directly; no database or browser.
const origin = 'https://shop.test';
const control = (id: string, extra: Partial<ObservedControl> = {}): ObservedControl =>
  ({ control_id: id, role: 'button', name: id, href: null, disabled: false, ambiguous: false, submits_form: false, ...extra });
const row = (id: string, url: string, planning: Record<string, unknown>, controls: ObservedControl[], auth?: string): StateRow => ({
  state_id: id, fingerprint: id.padEnd(64, '0'), url, map_state_key: null, page_template: null, planning, created_at: '2026-11-01T20:00:00Z',
  origin_run_id: 'old-run', origin_state_id: id, capture_id: `capture-${id}`, capture_run_id: 'old-run', action_id: `action-${id}`, phase: 'after',
  sha256: 'a'.repeat(64), object_key: `captures/${id}.png`, metadata_key: `captures/${id}.json`, byte_length: '100',
  observation: { url, title: `Title ${id}`, text: '', controls, ...(auth ? { auth_context_id: auth } : {}) } as any });
const click = (id: string): BrowserCommand => ({ type: 'click', control: control(id) });
const edge = (from: string, to: string, action: string, command: BrowserCommand, routable = true): EdgeRow =>
  ({ from_state_id: from, to_state_id: to, source_run_id: 'old-run', source_action_id: action, command, expected_result: `${action} result`, control_key: null, routable });

function stopped() {
  const states = [
    row('blank', 'about:blank', { depth: 0, parent_state_id: null }, []),
    row('home', 'https://shop.test/', { depth: 0, parent_state_id: null, path_likelihood_score: 1 }, [control('shop'), control('help')]),
    row('shop', 'https://shop.test/shop', { depth: 1, parent_state_id: 'home', path_likelihood_score: .8 }, [control('sort'), control('lamp'), control('logout', { disabled: true })]),
    row('private', 'https://shop.test/account', { depth: 1, parent_state_id: 'home' }, [control('orders')], 'session-1'),
  ];
  const frontier: FrontierRow[] = [
    { state_id: 'home', control_id: 'shop', control: control('shop'), status: 'attempted', reason: null, action_id: 'a2', planning: {} },
    { state_id: 'home', control_id: 'help', control: control('help'), status: 'blocked', reason: 'unavailable_after_reveal', action_id: null, planning: {} },
    { state_id: 'shop', control_id: 'sort', control: control('sort'), status: 'unexplored', reason: null, action_id: null,
      planning: { proposal: { control_id: 'sort', goal: 'Sort by price', expected_result: 'Products reorder', likelihood: .6, action: { type: 'click' } } } },
    { state_id: 'shop', control_id: 'lamp', control: control('lamp'), status: 'unexplored', reason: null, action_id: null, planning: { proposal: { control_id: 'other', likelihood: 2 } } },
    { state_id: 'shop', control_id: 'logout', control: control('logout', { disabled: true }), status: 'blocked', reason: 'disabled_control', action_id: null, planning: {} },
    { state_id: 'private', control_id: 'orders', control: control('orders'), status: 'unexplored', reason: null, action_id: null, planning: {} },
  ];
  const edges = [
    edge('blank', 'home', 'a1', { type: 'navigate', url: 'https://shop.test/' }),
    edge('home', 'shop', 'a2', click('shop')),
    edge('home', 'private', 'a3', click('account')),
    edge('shop', 'shop', 'a4', click('lamp'), false),
  ];
  let n = 0;
  return rebuildGraph({ sourceRunId: 'old-run', origin, authContextId: null, states, frontier, edges, lastStateId: 'shop',
    purpose: 'exploration', trainingStatus: 'unreviewed', newId: () => `new-${++n}` });
}

test('a continuation rebuilds the stopped run graph under new state IDs', () => {
  const rebuilt = stopped(), { graph } = rebuilt;
  const id = (url: string) => graph.states.find(s => s.capture.observation.url === url)!.id;
  assert.deepEqual(graph.states.map(s => s.capture.observation.url), ['https://shop.test/', 'https://shop.test/shop'],
    'the blank start page and states from another sign-in context are left out');
  assert.equal(graph.root_state_id, id('https://shop.test/'));
  assert.equal(graph.root_action_id, null, 'the entry navigation started on the blank page, which is not carried over');
  const shop = graph.states.find(s => s.id === id('https://shop.test/shop'))!;
  assert.equal(shop.parent_state_id, id('https://shop.test/'));
  assert.equal(shop.depth, 1); assert.equal(shop.reach_estimate, .8);
  assert.deepEqual(shop.proposals.map(p => [p.control_id, p.likelihood]), [['sort', .6]], 'only valid pending rankings carry over');
  assert.equal(shop.capture.capture_id, 'capture-shop', 'copied states keep their original screenshot');
  assert.deepEqual(graph.states.find(s => s.id === graph.root_state_id)!.attempted, ['shop']);
  const statuses = Object.fromEntries(rebuilt.frontier.map(f => [f.control_id, [f.status, f.reason]]));
  assert.deepEqual(statuses.help, ['unexplored', null], 'a local block from the stopped run is tried again');
  assert.equal(statuses.logout[0], 'blocked', 'a policy block stays blocked');
  assert.equal(statuses.orders, undefined);
  assert.deepEqual(rebuilt.edges.map(e => e.source_action_id), ['a2', 'a4'], 'transitions touching left-out states are dropped');
  assert.deepEqual(graph.routes.map(r => r.source_action_id), ['a2'], 'only settled transitions between different states are routes');
  assert.deepEqual(graph.resume, { state_id: shop.id, url: 'https://shop.test/shop', action_id: 'action-shop', title: 'Title shop' });
});

test('a stopped page that cannot be reopened directly sends the continuation to its entry page', () => {
  const rebuilt = rebuildGraph({ sourceRunId: 'old-run', origin, authContextId: null, lastStateId: 'out',
    states: [row('out', 'https://shop.test/logout?token=abc', { depth: 0, parent_state_id: null }, [])], frontier: [], edges: [],
    purpose: 'exploration', trainingStatus: 'unreviewed' });
  assert.equal(rebuilt.graph.resume, null);
});

test('the planner carries on from an inherited graph: tried controls stay tried and old routes lead back', () => {
  const { graph } = stopped();
  const planner = new FrontierPlanner('https://shop.test/');
  planner.inherit(graph);
  const home = graph.root_state_id!, shop = graph.resume!.state_id;
  assert.equal(planner.rootStateId, home);
  assert.deepEqual(planner.available(home).map(c => c.control_id), ['help'], 'the control the stopped run tried is not offered again');
  assert.equal(planner.rank(shop, 5)[0].control_id, 'sort', 'the pending ranking from the stopped run is used without a new plan');
  // Landing back on the entry page reaches the shop through the inherited route.
  planner.plan(home, [{ control_id: 'help', goal: 'Help', expected_result: 'Help opens', likelihood: .1 }]);
  planner.attempted(home, click('help'), false);
  const back = planner.rank(home, 5).find(p => p.state_id === shop)!;
  assert.deepEqual(back.route.map(r => r.source_action_id), ['a2']);
  assert.deepEqual(back.path_state_ids, [home, shop]);
});

test('a continuation carries the explored graph forward and reopens the page where its run stopped', {
  skip: process.env.SCOUT_EXPLORER_INTEGRATION !== '1', timeout: 300000,
}, async t => {
  const { Store } = await import('../src/store.js');
  const { explore } = await import('../src/explorer.js');
  const { ModelClient } = await import('../src/model-client.js');
  const { explorationFixture } = await import('../src/exploration-fixture.js');
  const store = await new Store().open();
  const fixture = await explorationFixture();
  const client = new ModelClient({ provider: 'openrouter', model: 'scout-explorer-fixture:free', freeOnly: true });
  assert.equal(await client.ready(), 'protocol_fixture', 'This test must never use live paid providers.');
  const options = { client, allowedOrigins: [fixture.url], appMemory: false };
  const names = (report: any) => report.actions.map((a: any) => a.spec.command.type === 'navigate' ? a.spec.command.url.replace(fixture.url, '') : a.spec.command.control.name);
  const continuing = (previousRunIds: string[]) => ({ attempt: previousRunIds.length, previousRunIds, jobMaxActions: null, carriedActions: 0 });
  const named = (graph: any, edge: any) => edge.command.type === 'navigate' ? edge.command.url.replace(fixture.url, '') : edge.command.control.name;
  let first = '', second = '';
  try {
    await t.test('the stopped run explores the entry page and a product view', async () => {
      const result = await explore(store, fixture.url + '/atlas', { ...options, maxActions: 3 });
      assert.equal(result.report.run.lifecycle, 'completed', result.report.run.error);
      assert.deepEqual(names(result.report), ['/atlas', 'Products', 'Compare plans']);
      first = result.run_id;
    });
    await t.test('continuing reopens the last page, lands on its copied state and skips what was tried', async () => {
      const result = await explore(store, fixture.url + '/atlas', { ...options, maxActions: 2, resume: continuing([first]) });
      const report = result.report, graph = report.graph;
      assert.equal(report.run.lifecycle, 'completed', report.run.error);
      assert.deepEqual(names(report), ['/atlas/products', 'Pricing FAQ'], 'The continuation starts where the run stopped, not at the entry page.');
      assert.equal(report.actions[0].spec.exploration.purpose, 'resume');
      const carried = report.run.config.continued_graph;
      assert.equal(carried.source_run_id, first);
      assert.equal(carried.resume_url, fixture.url + '/atlas/products');
      const inherited = graph.states.filter((s: any) => s.inherited_from_run_id === first);
      assert.ok(inherited.length >= 3, JSON.stringify(graph.states.map((s: any) => s.url)));
      const landing = graph.edges.find((e: any) => e.action_id === report.actions[0].action_id).to_state_id;
      assert.ok(inherited.some((s: any) => s.state_id === landing), 'The reopened page is the same state the stopped run recorded.');
      const tried = graph.frontier.filter((f: any) => f.state_id === landing && f.status === 'attempted').map((f: any) => f.control.name).sort();
      assert.deepEqual(tried, ['Compare plans', 'Pricing FAQ'], 'The tried control carried over and only the untried one was used.');
      assert.deepEqual(graph.inherited_edges.map((e: any) => [named(graph, e), e.routable]), [['Products', true], ['Compare plans', true]],
        'Executed transitions carry over; the entry navigation started on the blank page, which is not copied.');
      assert.equal(new Set(graph.states.map((s: any) => s.fingerprint)).size, graph.states.length);
      second = result.run_id;
    });
    await t.test('continuing a continuation carries the whole chain, keeping where each state was first recorded', async () => {
      const result = await explore(store, fixture.url + '/atlas', { ...options, maxActions: 1, resume: continuing([first, second]) });
      const report = result.report, graph = report.graph;
      assert.equal(report.run.lifecycle, 'completed', report.run.error);
      assert.equal(report.run.config.continued_graph.source_run_id, second);
      assert.deepEqual(names(report), ['/atlas/products']);
      assert.deepEqual(graph.inherited_edges.map((e: any) => [named(graph, e), e.source_run_id]),
        [['Products', first], ['Compare plans', first], ['Pricing FAQ', second]], 'Inherited transitions come first, then the stopped run\'s own.');
      const root = graph.states.find((s: any) => s.url === fixture.url + '/atlas');
      assert.equal(root.inherited_from_run_id, first, 'A state copied twice still names the run that recorded it.');
    });
  } finally {
    await fixture.close();
    await store.close();
  }
});
