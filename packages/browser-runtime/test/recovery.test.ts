import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { explore } from '../src/explorer.js';
import { image } from '../src/recorder.js';
import { ModelClient } from '../src/model-client.js';
import { explorationFixture } from '../src/exploration-fixture.js';
import type { Page } from 'playwright';

test('local recovery and reliable returns with real browser evidence', {
  skip: process.env.SCOUT_EXPLORER_INTEGRATION !== '1', timeout: 300000,
}, async t => {
  const store = await new Store().open(), fixture = await explorationFixture();
  const client = new ModelClient({ provider: 'openrouter', model: 'scout-explorer-fixture:free', freeOnly: true });
  assert.equal(await client.ready(), 'protocol_fixture', 'Never use paid providers in recovery tests.');
  const run = (path: string, extra: Parameters<typeof explore>[2] = {}) => explore(store, fixture.url + path,
    { client, allowedOrigins: [fixture.url], maxActions: 12, ...extra });
  try {
    await t.test('all five dead-end leaves remain reachable after repeated successful root returns', async () => {
      const result = await run('/recovery/entry', { maxActions: 18 });
      assert.equal(result.report.run.lifecycle, 'completed', result.report.run.error);
      const leaves = result.report.actions.filter(a => a.spec.command.control?.name.startsWith('Open leaf'));
      assert.equal(new Set(leaves.map(a => a.spec.command.control.name)).size, 5);
      assert.equal(result.report.actions.filter(a => a.spec.exploration?.return_step?.reset).length, 4);
      assert.equal(result.report.actions.filter(a => a.spec.command.control?.name === 'Open catalogue').length, 5);
      assert.equal(result.report.actions.filter(a => a.dispatched_at).length, 15);
      assert.ok(result.report.actions.every(a => a.before_capture_id && a.after_capture_id && a.assessment));
    });
    await t.test('persistent root drift yields to its five observed links without clicking stale controls', async () => {
      const result = await run('/recovery/drift', { hooks: { screenshot: async (page, phase, ordinal) => {
        if (phase === 'before' && ordinal > 1 && new URL(page.url()).pathname === '/recovery/drift')
          await page.evaluate(value => { document.querySelector('#status')!.textContent = `Update ${value}`; }, ordinal);
        return image(page);
      } } });
      assert.equal(result.report.run.lifecycle, 'completed', result.report.run.error);
      assert.equal(result.report.run.config.replans, 3);
      assert.equal(result.report.actions.filter(a => a.state === 'skipped').length, 3);
      const dispatched = result.report.actions.filter(a => a.dispatched_at);
      assert.ok(dispatched.every(a => a.spec.command.type === 'navigate'));
      assert.equal(new Set(dispatched.map(a => a.spec.command.url).filter(url => /\/recovery\/leaf-/.test(url))).size, 5);
      assert.ok(result.report.events.some(e => e.event_type === 'exploration.branch_deferred'));
      assert.ok(result.report.actions.filter(a => a.state === 'skipped').every(a => a.before_capture_id && !a.after_capture_id && !a.dispatched_at));
    });
    await t.test('successful progress permits more than three total stale-plan recoveries', async () => {
      let lastChangedAction = 0;
      const result = await run('/recovery/hub', { hooks: { screenshot: async (page, phase, ordinal) => {
        if (phase === 'before' && ordinal > 1 && new URL(page.url()).pathname === '/recovery/hub' && ordinal > lastChangedAction + 1) {
          lastChangedAction = ordinal;
          await page.evaluate(value => { document.querySelector('#status')!.textContent = `Update ${value}`; }, ordinal);
        }
        return image(page);
      } } });
      assert.equal(result.report.run.lifecycle, 'completed', result.report.run.error);
      assert.ok(result.report.run.config.replans > 3);
      assert.equal(new Set(result.report.actions.filter(a => a.spec.command.control?.name.startsWith('Open leaf')).filter(a => a.dispatched_at)
        .map(a => a.spec.command.control.name)).size, 5);
      assert.ok(!result.report.events.some(e => e.event_type === 'exploration.branch_deferred'));
    });
    await t.test('six controls becoming disabled at dispatch retain evidence and do not prevent reaching another leaf', async () => {
      let activePage: Page;
      const result = await run('/recovery/tool', { hooks: {
        screenshot: async (page) => { activePage = page; return image(page); },
        afterDispatch: async ordinal => {
          if (ordinal >= 2 && ordinal <= 7) await activePage.evaluate(n => {
            document.querySelectorAll('button')[n - 2].setAttribute('disabled', '');
          }, ordinal);
        },
      } });
      assert.equal(result.report.run.lifecycle, 'completed', result.report.run.error);
      const failures = result.report.actions.filter(a => a.spec.command.control?.name.startsWith('Preview'));
      assert.equal(failures.length, 6);
      assert.equal(new Set(failures.map(a => a.spec.command.control.control_id)).size, 6);
      assert.ok(failures.every(a => a.before_capture_id && a.after_capture_id && a.comparison && a.assessment.verdict === 'inconclusive'));
      assert.equal(result.report.events.filter(e => e.event_type === 'exploration.action_recovered').length, 6);
      assert.ok(result.report.actions.some(a => a.spec.command.control?.name === 'Open leaf 1' && a.dispatched_at));
    });
    await t.test('six covered lower controls are skipped locally and a later leaf still opens', async () => {
      const result = await run('/recovery/covered', { maxActions: 4 });
      assert.equal(result.report.run.lifecycle, 'completed', result.report.run.error);
      const skipped = result.report.actions.filter(a => a.state === 'skipped');
      assert.equal(skipped.length, 6);
      assert.ok(skipped.every(a => a.assessment.method === 'reveal-guard' && a.before_capture_id && !a.dispatched_at));
      assert.equal(result.report.run.config.reveal_failures, 6);
      assert.ok(result.report.actions.some(a => a.spec.command.control?.name === 'Open leaf 1' && a.dispatched_at));
      assert.ok(!fixture.requests.includes('/forbidden-covered'));
    });
  } finally { await fixture.close(); await store.close(); }
});
