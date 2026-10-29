import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store, hash } from '../src/store.js';
import { fixture, plan } from '../src/fixture.js';
import { record, image } from '../src/recorder.js';
import { validatePlan } from '../src/contracts.js';

test('invalid scope and missing expectations are rejected before execution', () => {
  assert.throws(() => validatePlan('https://example.com', plan('https://example.com')), /controlled fixture/);
  const invalid = plan('http://127.0.0.1:3333/');
  invalid[0].command = { type: 'navigate', url: 'http://postgres:5432/' };
  assert.throws(() => validatePlan('http://127.0.0.1:3333/', invalid), /allowed fixture/);
  const missing = plan('http://127.0.0.1:3333/');
  Reflect.deleteProperty(missing[0].prediction, 'expected');
  assert.throws(() => validatePlan('http://127.0.0.1:3333/', missing), /Unsupported expectation/);
});

test('real browser recording, failure handling, storage and telemetry', { timeout: 120000 }, async t => {
  const store = await new Store().open();
  const target = await fixture();
  let recordedRun = '';
  try {
    await t.test('working flow preserves every action, capture, prediction and assessment', async () => {
      const result = await record(store, target.url, plan(target.url));
      recordedRun = result.run_id;
      assert.equal(result.report.run.lifecycle, 'completed');
      assert.equal(result.report.run.workspace_id, store.workspaceId);
      assert.equal(result.report.run.user_id, store.userId);
      assert.equal(result.report.run.target_url, target.url);
      assert.equal(result.manifest_error, null);
      assert.equal(result.export_error, null);
      assert.equal(result.report.actions.length, 2);
      assert.equal(result.report.captures.length, 4);
      assert.equal(new Set(result.report.captures.map(c => c.capture_id)).size, 4);
      for (const action of result.report.actions) {
        assert.equal(action.assessment.verdict, 'no_issue_observed');
        assert.equal(action.assessment.confirmed_bug, false);
        assert.ok(action.prediction_id && action.before_capture_id && action.after_capture_id);
        assert.ok(action.created_at <= action.dispatched_at);
      }
      for (const capture of result.report.captures) {
        assert.equal(capture.status, 'available');
        assert.equal(hash(await store.captureBytes(capture.capture_id)), capture.sha256);
        const metadata = JSON.parse((await store.get(capture.metadata_key)).toString());
        assert.equal(metadata.capture_id, capture.capture_id);
        assert.equal(metadata.action_id, capture.action_id);
        assert.equal(metadata.training_status, 'excluded_fixture');
      }
      const manifest = JSON.parse((await store.get(result.report.run.manifest_key)).toString());
      assert.equal(manifest.run.run_id, result.run_id);
      assert.equal(manifest.actions[1].action_id, result.report.actions[1].action_id);
      assert.equal(manifest.model_usage.input_tokens, null);
      assert.equal(manifest.model_usage.output_tokens, null);
      assert.equal(manifest.model_usage.status, 'not_connected');
      assert.deepEqual(manifest.model_requests, []);
      assert.deepEqual(manifest.model_calls, []);
      const seq = result.report.events.map(e => Number(e.seq));
      assert.deepEqual(seq, seq.map((_, i) => i + 1));
    });
    await t.test('a broken button is assessed even when the pixel mask is empty', async () => {
      const result = await record(store, target.url, plan(target.url, 'broken'));
      const action = result.report.actions[1];
      assert.equal(action.assessment.verdict, 'suspect');
      assert.equal(action.assessment.actual, 'Ready');
      assert.equal(action.assessment.confirmed_bug, false);
      assert.equal(action.comparison.counts.changed_pixels, 0);
    });
    await t.test('one changed pixel survives the real browser capture and persisted mask', async () => {
      const result = await record(store, target.url, plan(target.url, 'tiny'));
      assert.equal(result.report.actions[1].assessment.verdict, 'no_issue_observed');
      assert.equal(result.report.actions[1].comparison.counts.changed_pixels, 1);
      assert.equal(result.report.actions[1].comparison.max_overlap_channel_delta, 1);
    });
    await t.test('a tool timeout still captures after state and produces an inconclusive check', async () => {
      const result = await record(store, target.url, plan(target.url, 'timeout'));
      assert.equal(result.report.run.lifecycle, 'failed');
      assert.equal(result.report.actions[1].state, 'completed');
      assert.equal(result.report.actions[1].assessment.verdict, 'inconclusive');
      assert.ok(result.report.actions[1].after_capture_id);
    });
    await t.test('a missing before image prevents navigation from being dispatched', async () => {
      let dispatched = 0;
      const result = await record(store, target.url, plan(target.url), {
        screenshot: async () => { throw new Error('injected capture failure'); },
        afterDispatch: async () => { dispatched++; },
      });
      assert.equal(dispatched, 0);
      assert.equal(result.report.actions.length, 1);
      assert.equal(result.report.actions[0].dispatched_at, null);
      assert.equal(result.report.actions[0].assessment.verdict, 'inconclusive');
      assert.equal(result.report.run.lifecycle, 'failed');
    });
    await t.test('a missing after image blocks the next action and preserves the evidence gap', async () => {
      let dispatched = 0;
      const result = await record(store, target.url, plan(target.url), {
        screenshot: async (page, phase) => { if (phase === 'after') throw new Error('injected after failure'); return image(page); },
        afterDispatch: async () => { dispatched++; },
      });
      assert.equal(dispatched, 1);
      assert.equal(result.report.actions.length, 1);
      assert.ok(result.report.actions[0].before_capture_id);
      assert.equal(result.report.actions[0].after_capture_id, null);
      assert.equal(result.report.captures[1].status, 'failed');
      assert.equal(result.report.actions[0].state, 'evidence_failed');
    });
    await t.test('a DOM read failure preserves the captured image and cannot pass the assessment', async () => {
      const result = await record(store, target.url, plan(target.url), {
        screenshot: async (page, phase) => { const bytes = await image(page); if (phase === 'after') await page.close(); return bytes; },
      });
      assert.equal(result.report.run.lifecycle, 'failed');
      assert.equal(result.report.actions.length, 1);
      assert.equal(result.report.actions[0].assessment.verdict, 'inconclusive');
      assert.equal(result.report.captures[1].status, 'available');
      assert.ok(result.report.captures[1].observation.observation_error);
      assert.equal(hash(await store.get(result.report.captures[1].object_key)), result.report.captures[1].sha256);
    });
    await t.test('an exporter outage retains committed events and replay does not inflate counts', async () => {
      await store.query('UPDATE runtime_events SET exported_at=NULL WHERE run_id=$1', [recordedRun]);
      await assert.rejects(() => store.flush(async () => { throw new Error('simulated outage'); }), /simulated outage/);
      assert.ok(Number((await store.query('SELECT count(*) FROM runtime_events WHERE run_id=$1 AND exported_at IS NULL', [recordedRun])).rows[0].count) > 0);
      await store.flush();
      const count = JSON.parse(await store.clickhouse(`SELECT count() AS n FROM scout.runtime_events_current WHERE run_id='${recordedRun}' FORMAT JSONEachRow`));
      assert.equal(Number(count.n), (await store.report(recordedRun)).events.length);
    });
    await t.test('capture upload recovery restores identical bytes from the durable spool', async () => {
      const originalPut = store.put.bind(store);
      let failed = false;
      store.put = async (key, bytes, mediaType) => {
        if (!failed && key.includes('/captures/')) { failed = true; throw new Error('injected capture upload outage'); }
        return originalPut(key, bytes, mediaType);
      };
      let result: Awaited<ReturnType<typeof record>>;
      try { result = await record(store, target.url, plan(target.url)); }
      finally { store.put = originalPut; }
      const capture = result.report.captures[0];
      assert.equal(result.report.run.lifecycle, 'failed');
      assert.equal(capture.status, 'pending_upload');
      assert.equal(result.report.actions[0].dispatched_at, null);
      await assert.rejects(() => store.get(capture.metadata_key));
      await store.recover(result.run_id);
      const restored = (await store.query('SELECT status,sha256 FROM runtime_captures WHERE capture_id=$1', [capture.capture_id])).rows[0];
      assert.equal(restored.status, 'available');
      assert.equal(restored.sha256, capture.sha256);
      assert.equal(hash(await store.get(capture.object_key)), capture.sha256);
      assert.equal(JSON.parse((await store.get(capture.metadata_key)).toString()).capture_id, capture.capture_id);
    });
    await t.test('interrupted dispatched actions become unknown outcomes and are never replayed', async () => {
      const actionId = randomUUID();
      await store.query("UPDATE runtime_runs SET lifecycle='active',finished_at=NULL WHERE run_id=$1", [recordedRun]);
      await store.query("INSERT INTO runtime_actions(action_id,run_id,ordinal,prediction_id,spec,state,dispatched_at) VALUES($1,$2,3,$3,$4,'dispatched',now())",
        [actionId, recordedRun, randomUUID(), JSON.stringify(plan(target.url)[1])]);
      await store.recover(recordedRun);
      const report = await store.report(recordedRun);
      assert.equal(report.run.lifecycle, 'failed');
      assert.equal(report.actions[2].state, 'interrupted');
      assert.match(report.actions[2].assessment.reason, /outcome is unknown/);
      assert.equal(report.actions[2].after_capture_id, null);
    });
    await store.flush();
  } finally { await target.close(); await store.close(); }
});
