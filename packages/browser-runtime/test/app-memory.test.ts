import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { explore, reproduce } from '../src/explorer.js';
import { ModelClient } from '../src/model-client.js';
import { explorationFixture } from '../src/exploration-fixture.js';

const names = (report: Awaited<ReturnType<typeof explore>>['report']) =>
  report.actions.map(a => a.spec.command.type === 'navigate' ? a.spec.command.url.replace(/^https?:\/\/[^/]+/, '') : a.spec.command.control.name);

test('cross-run app memory deepens exploration without replacing evidence', {
  skip: process.env.SCOUT_EXPLORER_INTEGRATION !== '1', timeout: 300000,
}, async t => {
  const store = await new Store().open();
  const fixture = await explorationFixture();
  const client = new ModelClient({provider:'openrouter',model:'scout-explorer-fixture:free',freeOnly:true});
  assert.equal(await client.ready(), 'protocol_fixture', 'This test must never use live paid providers.');
  const options = {client,allowedOrigins:[fixture.url],maxActions:3,appMemory:true};
  const scope = async (profile = 'desktop') => (await store.query(`SELECT * FROM app_memory_scopes WHERE workspace_id=$1 AND user_id=$2 AND origin=$3
    AND viewport_profile=$4 AND auth_scope='public' AND execution_mode='protocol_fixture'`, [store.workspaceId, store.userId, fixture.url, profile])).rows[0];
  const controls = async (scopeId: string) => Object.fromEntries((await store.query('SELECT * FROM app_memory_controls WHERE scope_id=$1', [scopeId])).rows.map(r => [r.control.name, r]));
  let suspect = '', firstRun = '', secondRun = '';
  const map = async (scopeId: string) => ({
    states: (await store.query('SELECT page_template,min_depth,runs FROM app_map_states WHERE scope_id=$1 ORDER BY min_depth,page_template', [scopeId])).rows
      .map(r => [r.page_template.replace(fixture.url, ''), r.min_depth, r.runs]),
    transitions: (await store.query('SELECT action,control,attempts,last_verdict FROM app_map_transitions WHERE scope_id=$1 ORDER BY first_seen_at,last_action_id', [scopeId])).rows
      .map(r => [r.action, r.control.name ?? r.control.url.replace(fixture.url, ''), r.attempts, r.last_verdict]),
  });
  const api = async (path: string) => {
    const response = await fetch((process.env.SCOUT_API_URL ?? 'http://api:8080') + path, { headers: { Authorization: `Bearer ${process.env.SCOUT_API_TOKEN}` } });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  try {
    await t.test('a memory-free run neither reads nor writes memory', async () => {
      const result = await explore(store, fixture.url + '/atlas', {...options, appMemory:false});
      assert.equal(result.report.run.lifecycle, 'completed', result.report.run.error);
      assert.deepEqual(names(result.report), ['/atlas', 'Products', 'Compare plans']);
      assert.deepEqual(result.report.run.config.app_memory, {version:'app-memory-v1',enabled:false,scopes:[]});
      assert.equal(await scope(), undefined);
    });
    await t.test('the first remembering run records pages, controls, proposals and outcomes', async () => {
      const result = await explore(store, fixture.url + '/atlas', options);
      assert.equal(result.report.run.lifecycle, 'completed', result.report.run.error);
      assert.deepEqual(names(result.report), ['/atlas', 'Products', 'Compare plans']);
      const summary = result.report.run.config.app_memory;
      assert.equal(summary.enabled, true);
      assert.equal(summary.scopes[0].prior_runs, 0);
      assert.ok(result.report.events.some(e => e.event_type === 'memory.loaded'));
      const remembered = await scope();
      assert.equal(remembered.runs, 1);
      const pages = (await store.query('SELECT url,visits,best_path_score FROM app_memory_pages WHERE scope_id=$1 ORDER BY url', [remembered.scope_id])).rows;
      assert.deepEqual(pages.map(p => [p.url.replace(fixture.url, ''), p.visits]), [['/atlas', 1], ['/atlas/products', 1]]);
      assert.equal(pages[1].best_path_score, .7);
      const byName = await controls(remembered.scope_id);
      assert.equal(byName['Products'].attempts, 1);
      assert.equal(byName['Products'].last_verdict, 'no_issue_observed');
      assert.equal(byName['Compare plans'].attempts, 1);
      assert.equal(byName['Pricing FAQ'].attempts, 0);
      assert.equal(byName['Pricing FAQ'].best_likelihood, .6);
      assert.equal(byName['Pricing FAQ'].last_run_id, result.run_id);
      firstRun = result.run_id;
      const recorded = await map(remembered.scope_id);
      assert.deepEqual(recorded.states.slice(0, 2), [['/atlas', 0, 1], ['/atlas/products', 1, 1]], 'The map keeps pages by depth from the entry page.');
      assert.deepEqual(recorded.transitions.map(t => t.slice(0, 2)), [['click', 'Products'], ['click', 'Compare plans']], 'The start page and navigation into it are not app transitions.');
      assert.ok(result.report.run.config.limits.max_actions === 3);
    });
    await t.test('the next run resumes the unfinished page instead of repeating the journey', async () => {
      const result = await explore(store, fixture.url + '/atlas', options);
      assert.equal(result.report.run.lifecycle, 'completed', result.report.run.error);
      assert.deepEqual(names(result.report), ['/atlas', '/atlas/products', 'Pricing FAQ']);
      assert.equal(result.report.run.config.app_memory.scopes[0].prior_runs, 1);
      const resume = result.report.actions[1];
      assert.equal(resume.spec.exploration.purpose, 'resume');
      assert.equal(resume.assessment.verdict, 'no_issue_observed');
      assert.ok(resume.before_capture_id && resume.after_capture_id && resume.comparison, 'A resumed page has the same evidence as any action.');
      const selection = result.report.graph.selections.find((s: any) => s.action_id === resume.action_id);
      assert.equal(selection.purpose, 'resume');
      const repeated = selection.ranked_paths.find((p: any) => p.name === 'Products');
      assert.equal(repeated.components.earlier_run_coverage, .2);
      assert.ok(selection.selected.priority > repeated.priority);
      const faq = result.report.actions[2];
      assert.equal(faq.assessment.verdict, 'suspect');
      const plan = (await store.query("SELECT spec FROM model_requests WHERE request_id=$1", [faq.spec.prediction.request_id])).rows[0].spec;
      const input = JSON.parse(plan.prompt);
      assert.equal(input.app_memory.prior_runs, 1);
      assert.deepEqual(input.app_memory.earlier_attempts_on_this_page.map((c: any) => c.name), ['Compare plans']);
      suspect = faq.action_id;
      const remembered = await scope();
      assert.equal(remembered.runs, 2);
      const byName = await controls(remembered.scope_id);
      assert.equal(byName['Pricing FAQ'].attempts, 1);
      assert.equal(byName['Pricing FAQ'].last_verdict, 'suspect');
      assert.equal(byName['Products'].attempts, 1, 'The repeated journey was skipped.');
      secondRun = result.run_id;
      const recorded = await map(remembered.scope_id);
      assert.deepEqual(recorded.states.slice(0, 2).map(s => [s[0], s[2]]), [['/atlas', 2], ['/atlas/products', 2]], 'Both runs reached the same pages.');
      assert.ok(recorded.transitions.some(t => t[1] === 'Pricing FAQ' && t[3] === 'suspect'));
      const diff = await api(`/v1/runs/${secondRun}/map-diff`);
      assert.equal(diff.compared_runs, 1); assert.equal(diff.previous_run_id, firstRun);
      assert.ok(diff.new_transitions.some((t: any) => t.name === 'Pricing FAQ' && t.verdict === 'suspect'), JSON.stringify(diff.new_transitions));
      assert.ok(!diff.new_transitions.some((t: any) => t.name === 'Products'), 'Products repeats nothing new.');
      assert.equal(diff.counts.regressions, 0);
      const view = await api(`/v1/app-memory/${remembered.scope_id}/map`);
      assert.equal(view.summary.states, recorded.states.length); assert.ok(view.summary.untried_controls >= 0);
      const root = view.states.find((s: any) => s.depth === 0);
      assert.ok(root.transitions.some((t: any) => t.control.name === 'Products' && t.to_page_template.endsWith('/atlas/products')));
    });
    await t.test('a suspect reached through a resumed page replays exactly and leaves memory unchanged', async () => {
      const result = await reproduce(store, suspect, {client,allowedOrigins:[fixture.url]});
      assert.equal(result.report.run.lifecycle, 'completed', result.report.run.error);
      assert.equal(result.report.reproductions[0].result.outcome, 'reproduced');
      assert.deepEqual(names(result.report), ['/atlas', '/atlas/products', 'Pricing FAQ']);
      assert.equal(result.report.run.config.app_memory.enabled, false);
      assert.equal((await scope()).runs, 2);
    });
    await t.test('another viewport keeps separate memory', async () => {
      const result = await explore(store, fixture.url + '/atlas', {...options, viewportProfile:'mobile'});
      assert.equal(result.report.run.lifecycle, 'completed', result.report.run.error);
      assert.equal(result.report.run.config.app_memory.scopes[0].prior_runs, 0);
      assert.deepEqual(names(result.report), ['/atlas', 'Products', 'Compare plans']);
      assert.equal((await scope('mobile')).runs, 1);
    });
    await t.test('without an action limit a run explores until nothing new is left', async () => {
      const result = await explore(store, fixture.url + '/atlas', {...options, viewportProfile:'tablet', appMemory:false, maxActions:null, stopAfterIdleActions:5});
      assert.equal(result.report.run.lifecycle, 'completed', result.report.run.error);
      assert.equal(result.report.run.config.limits.max_actions, null);
      assert.ok(['no_reachable_unexplored_controls','model_stopped_or_no_reachable_frontier','no_new_states'].includes(result.report.run.config.stop_reason), result.report.run.config.stop_reason);
      assert.ok(result.report.actions.length > 3, 'It goes past the three-action budget the other runs use.');
    });
    await t.test('a token limit stops before the next action once reported usage reaches it', async () => {
      const result = await explore(store, fixture.url + '/atlas', {...options, viewportProfile:'tablet', appMemory:false, maxActions:null, maxTokens:8});
      assert.equal(result.report.run.config.stop_reason, 'token_budget_reached');
      assert.equal(result.report.run.config.limits.max_tokens, 8);
      assert.ok(result.report.actions.length < 4);
    });
    await store.flush();
  } finally { await fixture.close(); await store.close(); }
});
