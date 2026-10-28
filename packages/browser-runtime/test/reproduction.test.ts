import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store, hash } from '../src/store.js';
import { explore, reproduce } from '../src/explorer.js';
import { ModelClient } from '../src/model-client.js';
import { explorationFixture } from '../src/exploration-fixture.js';

test('suspect verification replays once in a fresh browser and preserves evidence', {
  skip: process.env.SCOUT_EXPLORER_INTEGRATION !== '1', timeout: 180000,
}, async t => {
  const store = await new Store().open(), fixture = await explorationFixture();
  const client = new ModelClient({provider:'openrouter',model:'scout-reproduction-fixture:free',freeOnly:true});
  const options = {client,allowedOrigins:[fixture.url],maxActions:2};
  assert.equal(await client.ready(), 'protocol_fixture', 'Reproduction tests must never charge a live provider.');
  const source = async (path: string) => {
    const run = await explore(store, fixture.url + path, options);
    assert.equal(run.report.run.lifecycle, 'completed', run.report.run.error);
    assert.equal(run.report.actions[1].assessment.verdict, 'suspect');
    return run;
  };
  try {
    await t.test('a mobile suspect after an automatic return replays the full recorded path at its source viewport',async()=>{
      const original=await explore(store,fixture.url+'/tree',{...options,maxActions:5,viewportProfile:'mobile'});
      assert.equal(original.report.run.lifecycle,'completed',original.report.run.error);
      const suspect=original.report.actions.at(-1)!;
      assert.equal(suspect.assessment.verdict,'suspect');
      assert.equal(original.report.actions[2].spec.exploration.purpose,'return');
      const replay=await reproduce(store,suspect.action_id,options);
      assert.equal(replay.report.run.lifecycle,'completed',replay.report.run.error);
      assert.equal(replay.report.run.config.viewport_profile,'mobile');
      assert.equal(replay.report.actions.length,5);
      assert.equal(replay.report.reproductions[0].result.outcome,'reproduced');
    });
    await t.test('a persistent bug gets distinct evidence and one independent assessment per replayed action', async () => {
      const original = await source('/broken-session');
      const sourceAction = original.report.actions[1];
      const originalManifest = await store.get(original.report.run.manifest_key);
      const result = await reproduce(store, sourceAction.action_id, options);
      assert.equal(result.report.run.lifecycle, 'completed', result.report.run.error);
      assert.equal(result.manifest_error, null);
      assert.equal(result.export_error, null);
      assert.equal(result.reused, false);
      assert.equal(result.report.run.config.expectation_source, 'recorded_replay');
      assert.notEqual(result.run_id, original.run_id);
      assert.notEqual(result.report.run.config.worker_id, original.report.run.config.worker_id);
      assert.notEqual(result.report.run.config.agent_id, original.report.run.config.agent_id);
      assert.equal(result.report.actions.length, 2);
      assert.equal(result.report.captures.length, 4);
      assert.equal(result.report.model_requests.length, 2);
      assert.equal(result.report.model_usage.known_input_tokens, 6);
      assert.equal(result.report.model_usage.known_output_tokens, 4);
      assert.equal(result.report.reproductions[0].result.outcome, 'reproduced');
      assert.equal(result.report.reproductions[0].result.confirmed_bug, false);
      for (const [index, action] of result.report.actions.entries()) {
        const originalAction = original.report.actions[index];
        assert.notEqual(action.action_id, originalAction.action_id);
        assert.notEqual(action.prediction_id, originalAction.prediction_id);
        assert.equal(action.spec.prediction.source, 'recorded_replay');
        assert.equal(action.spec.prediction.expected_result, originalAction.spec.prediction.expected_result);
        assert.equal(action.spec.prediction.source_prediction_id, originalAction.prediction_id);
        assert.equal(action.spec.replay_source_action_id, originalAction.action_id);
        assert.ok(action.created_at <= action.dispatched_at);
        const model = (await store.query('SELECT spec FROM model_requests WHERE request_id=$1', [action.assessment.request_id])).rows[0].spec;
        const prompt = JSON.parse(model.prompt);
        assert.equal(prompt.task, 'assessment');
        assert.ok(!('original_assessment' in prompt) && !('source_assessment' in prompt));
        assert.deepEqual(model.capture_ids, [action.before_capture_id, action.after_capture_id]);
        assert.ok(!model.capture_ids.some((id: string) => original.report.captures.some(c => c.capture_id === id)));
      }
      assert.deepEqual(fixture.cookies.filter(c => c.path === '/broken-session').map(c => c.value), ['', '']);
      for (const c of result.report.captures) assert.equal(hash(await store.captureBytes(c.capture_id)), c.sha256);
      const manifest = JSON.parse((await store.get(result.report.run.manifest_key)).toString());
      assert.equal(manifest.reproductions[0].result.outcome, 'reproduced');
      const unchanged = await store.report(original.run_id);
      assert.deepEqual(unchanged.actions, original.report.actions);
      assert.deepEqual(unchanged.events, original.report.events);
      assert.equal(unchanged.reproductions[0].replay_run_id, result.run_id);
      assert.equal(hash(await store.get(unchanged.run.manifest_key)), hash(originalManifest));

      const visits = fixture.requests.length;
      const again = await reproduce(store, sourceAction.action_id, options);
      assert.equal(again.reused, true);
      assert.equal(again.run_id, result.run_id);
      assert.equal(fixture.requests.length, visits);
      assert.equal(again.report.model_calls.length, result.report.model_calls.length);
    });
    await t.test('a repaired control is not reproduced without rewriting the original suspicion', async () => {
      const original = await source('/broken-repaired');
      fixture.setOutcome('/broken-repaired', 'saved');
      const result = await reproduce(store, original.report.actions[1].action_id, options);
      assert.equal(result.report.run.lifecycle, 'completed', result.report.run.error);
      assert.equal(result.report.reproductions[0].result.outcome, 'not_reproduced');
      assert.equal(result.report.actions[1].assessment.verdict, 'no_issue_observed');
      assert.equal((await store.report(original.run_id)).actions[1].assessment.verdict, 'suspect');
    });
    await t.test('a different failure stays inconclusive rather than confirming the wrong bug', async () => {
      const original = await source('/broken-different');
      fixture.setOutcome('/broken-different', 'different_failure');
      const result = await reproduce(store, original.report.actions[1].action_id, options);
      assert.equal(result.report.run.lifecycle, 'completed', result.report.run.error);
      assert.equal(result.report.actions[1].assessment.verdict, 'suspect');
      assert.equal(result.report.reproductions[0].result.outcome, 'inconclusive');
      assert.equal(result.report.reproductions[0].result.matching_after_state, false);
    });
    await t.test('changed prerequisites prevent dispatch of the suspect step', async () => {
      const original = await source('/broken-missing');
      fixture.setOutcome('/broken-missing', 'missing_control');
      const result = await reproduce(store, original.report.actions[1].action_id, options);
      assert.equal(result.report.run.lifecycle, 'failed');
      assert.match(result.report.run.error, /preconditions differ/);
      assert.equal(result.report.actions[1].dispatched_at, null);
      assert.equal(result.report.model_requests.length, 1);
      assert.equal(result.report.reproductions[0].result.outcome, 'inconclusive');
    });
    await t.test('unsupported, missing and non-suspect sources create no replay or model calls', async () => {
      const healthy = await explore(store, fixture.url + '/working', options);
      const counts = async () => (await store.query('SELECT (SELECT count(*) FROM runtime_runs) AS runs,(SELECT count(*) FROM model_requests) AS requests')).rows[0];
      const before = await counts();
      await assert.rejects(() => reproduce(store, healthy.report.actions[1].action_id, options), /completed explorer suspect/);
      await assert.rejects(() => reproduce(store, randomUUID(), options), /not found/);
      await assert.rejects(() => reproduce(store, 'invalid', options), /Invalid/);
      assert.deepEqual(await counts(), before);
    });
    await t.test('interrupted replay recovery never repeats browser actions or upgrades a result', async () => {
      const original = await source('/broken-interrupted');
      const result = await reproduce(store, original.report.actions[1].action_id, options);
      // Simulate the durable boundary after dispatch and before final settlement.
      await store.query("UPDATE runtime_reproductions SET status='active',result=NULL,finished_at=NULL WHERE replay_run_id=$1", [result.run_id]);
      await store.query("UPDATE runtime_runs SET lifecycle='active',finished_at=NULL WHERE run_id=$1", [result.run_id]);
      await store.query("UPDATE runtime_actions SET state='dispatched',assessment=NULL,finished_at=NULL WHERE action_id=$1", [result.report.actions[1].action_id]);
      const visits = fixture.requests.length, calls = result.report.model_calls.length;
      await store.recover(result.run_id);
      const recovered = await store.report(result.run_id);
      assert.equal(recovered.reproductions[0].status, 'interrupted');
      assert.equal(recovered.reproductions[0].result.outcome, 'inconclusive');
      assert.equal(recovered.actions[1].assessment.method, 'model-evidence-v1');
      assert.equal(recovered.actions[1].assessment.verdict, 'inconclusive');
      assert.equal(fixture.requests.length, visits);
      assert.equal(recovered.model_calls.length, calls);
      const again = await reproduce(store, original.report.actions[1].action_id, options);
      assert.equal(again.reused, true);
      assert.equal(again.report.model_calls.length, calls);
    });
    await store.flush();
  } finally { await fixture.close(); await store.close(); }
});
