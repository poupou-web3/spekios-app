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
  let suspect = '';
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
    await store.flush();
  } finally { await fixture.close(); await store.close(); }
});
