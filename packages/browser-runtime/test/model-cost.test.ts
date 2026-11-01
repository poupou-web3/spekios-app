import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { explore } from '../src/explorer.js';
import { ModelClient } from '../src/model-client.js';
import { explorationFixture } from '../src/exploration-fixture.js';

const MAIN = 'scout-explorer-fixture:free', LITE = 'scout-explorer-lite:free';
const names = (report: Awaited<ReturnType<typeof explore>>['report']) =>
  report.actions.map(a => a.spec.command.type === 'navigate' ? 'navigate' : a.spec.command.control.name);

test('fewer and cheaper model calls keep the same evidence', {
  skip: process.env.SCOUT_EXPLORER_INTEGRATION !== '1', timeout: 300000,
}, async t => {
  const store = await new Store().open();
  const fixture = await explorationFixture();
  const client = new ModelClient({provider:'openrouter',model:MAIN,freeOnly:true});
  const lite = new ModelClient({provider:'openrouter',model:LITE,freeOnly:true});
  assert.equal(await client.ready(), 'protocol_fixture', 'This test must never use live paid providers.');
  // Each recorded model request with its task, model and action.
  const requests = async (runId: string) => (await store.query('SELECT request_id,model,action_id,spec FROM model_requests WHERE run_id=$1 ORDER BY created_at,request_id', [runId])).rows
    .map(r => ({ request_id: r.request_id as string, model: r.model as string, action_id: r.action_id as string | null, task: JSON.parse(r.spec.prompt).task as string }));
  try {
    await t.test('a navigation model predicts and assesses navigation; buttons and plans keep the main model', async () => {
      const result = await explore(store, fixture.url + '/tree', {client, navigationClient:lite, allowedOrigins:[fixture.url], maxActions:5});
      assert.equal(result.report.run.lifecycle, 'completed', result.report.run.error);
      assert.deepEqual(names(result.report), ['navigate','Catalog','navigate','Help','Save draft'], 'The path is the same as with one model.');
      const seen = await requests(result.run_id);
      const action = (id: string | null) => result.report.actions.find(a => a.action_id === id);
      for (const r of seen) {
        const a = action(r.action_id), navigation = r.task === 'navigation_prediction' || r.task === 'route_prediction'
          || r.task === 'assessment' && (a.spec.command.type === 'navigate' || a.spec.command.control.role === 'link');
        assert.equal(r.model, navigation ? LITE : MAIN, `${r.task} for ${a ? names({ ...result.report, actions: [a] })[0] : 'the plan'}`);
      }
      assert.ok(seen.some(r => r.model === MAIN && r.task === 'plan'));
      const save = result.report.actions[4];
      assert.equal(save.assessment.model_tier, 'main');
      assert.equal(save.assessment.verdict, 'suspect');
      assert.ok(result.report.actions.slice(0, 4).every(a => a.assessment.model_tier === 'navigation' && !a.assessment.screening));
      assert.equal(result.report.run.config.model_tiers.navigation.model, LITE);
      const use = result.report.run.config.model_use;
      assert.equal(use.navigation_requests, seen.filter(r => r.model === LITE).length);
      assert.deepEqual([use.escalations, use.fallbacks], [0, 0]);
    });
    await t.test('a navigation result that is not clean is assessed again by the main model', async () => {
      const result = await explore(store, fixture.url + '/uncertain', {client, navigationClient:lite, allowedOrigins:[fixture.url], maxActions:2});
      assert.equal(result.report.run.lifecycle, 'completed', result.report.run.error);
      const open = result.report.actions[0];
      assert.equal(open.assessment.model_tier, 'main');
      assert.equal(open.assessment.screening.reason, 'not_no_issue_observed');
      assert.equal(open.assessment.verdict, 'inconclusive', 'The main model still marks the expectation uncertain.');
      const seen = await requests(result.run_id);
      assert.equal(seen.find(r => r.request_id === open.assessment.screening.request_id)!.model, LITE);
      assert.equal(seen.find(r => r.request_id === open.assessment.request_id)!.model, MAIN);
      assert.equal(result.report.run.config.model_use.escalations, 1);
    });
    await t.test('an unchanged screen reuses its ranking from an earlier run instead of asking again', async () => {
      const options = {client, allowedOrigins:[fixture.url], maxActions:8, appMemory:true, reuseRankings:true};
      const first = await explore(store, fixture.url + '/branches', options);
      assert.equal(first.report.run.lifecycle, 'completed', first.report.run.error);
      assert.equal(first.report.run.config.model_use.rankings_stored, 3, 'The entry page, Help and Settings were each ranked once on a first visit.');
      assert.equal(first.report.run.config.model_use.plans_reused, 0);
      const second = await explore(store, fixture.url + '/branches', options);
      assert.equal(second.report.run.lifecycle, 'completed', second.report.run.error);
      const reused = second.report.graph.decisions.filter((d: any) => d.status === 'reused');
      assert.ok(reused.length >= 1);
      assert.equal(second.report.run.config.model_use.plans_reused, reused.length);
      const plans = async (runId: string) => (await requests(runId)).filter(r => r.task === 'plan').length;
      assert.ok(await plans(second.run_id) < await plans(first.run_id), 'Fewer planning requests than the first run.');
      const seen = new Set((await requests(second.run_id)).map(r => r.request_id));
      for (const d of reused) {
        assert.equal(d.kind, 'plan');
        assert.equal(d.result.reused_from.run_id, first.run_id);
        assert.ok(!seen.has(d.request_id), 'A reused ranking makes no model request.');
      }
      const acted = second.report.actions.filter((a: any) => a.spec.prediction.reused_ranking);
      assert.ok(acted.length >= 1, 'At least one action came from a reused ranking.');
      for (const a of acted) {
        assert.ok(reused.some((d: any) => d.request_id === a.spec.prediction.request_id));
        assert.equal(a.spec.prediction.reused_ranking.run_id, first.run_id);
        assert.ok(a.before_capture_id && a.after_capture_id && a.assessment, 'Evidence and assessment are unchanged.');
      }
      const scope = second.report.run.config.app_memory.scopes[0].scope_id;
      const counted = (await store.query('SELECT sum(reuses)::int AS reuses FROM app_map_rankings WHERE scope_id=$1', [scope])).rows[0].reuses;
      assert.equal(counted, reused.length);
      const off = await explore(store, fixture.url + '/branches', {...options, reuseRankings:false});
      assert.equal(off.report.run.config.model_use.plans_reused, 0, 'Turning reuse off asks the model every time.');
    });
    await store.flush();
  } finally { await fixture.close(); await store.close(); }
});
