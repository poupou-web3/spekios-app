import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { spawn } from 'node:child_process';
import { clients, getObject, root, sha256, sqlString } from './local-clients.mjs';

const env = parseEnv(await readFile(new URL('../.env', import.meta.url), 'utf8'));
const { s3, clickhouse } = await clients();
const request = async path => {
  const response = await fetch('http://127.0.0.1:18080' + path, {
    headers: { Authorization: `Bearer ${env.SCOUT_API_TOKEN}` },
    signal: AbortSignal.timeout(10000), redirect: 'error',
  });
  assert.equal(response.status, 200);
  return response.json();
};
const run = (command, id) => new Promise((resolve, reject) => {
  const child = spawn('docker', ['compose', 'run', '--rm', '--no-deps',
    '-e', 'SCOUT_EXPLORER_PROVIDER=openrouter', '-e', 'SCOUT_EXPLORER_MODEL=scout-reproduction-fixture:free',
    '-e', 'SCOUT_EXPLORER_MAX_ACTIONS=2', 'recorder', command, id], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
  let output = '';
  child.stdout.on('data', chunk => output += chunk);
  child.on('error', reject);
  child.on('close', code => {
    if (code !== 0) return reject(new Error(`Recorder ${command} exited ${code}: ${output.slice(0, 1500)}`));
    try { resolve(JSON.parse(output)); } catch (error) { reject(error); }
  });
});

try {
  assert.equal((await request('/v1/model-providers')).test_mode, true, 'Tests require simulated providers; never use live billing.');
  const original = await run('explore', 'http://exploration-fixture:8082/broken-session');
  const source = await request('/v1/runs/' + original.run_id);
  const sourceAction = source.actions[1];
  assert.equal(sourceAction.assessment.verdict, 'suspect');
  const originalManifest = await getObject(s3, source.run.manifest_key);

  const replay = await run('reproduce', sourceAction.action_id);
  assert.equal(replay.lifecycle, 'completed');
  assert.equal(replay.reused, false);
  assert.equal(replay.manifest_error, null);
  assert.equal(replay.export_error, null);
  assert.equal(replay.actions, 2);
  assert.equal(replay.captures, 4);
  assert.equal(replay.model_usage.attempts, 2);
  assert.equal(replay.model_usage.known_input_tokens, 6);
  assert.equal(replay.model_usage.known_output_tokens, 4);
  const report = await request('/v1/runs/' + replay.run_id);
  assert.equal(report.run.config.expectation_source, 'recorded_replay');
  assert.equal(report.reproductions[0].result.outcome, 'reproduced');
  assert.equal(report.reproductions[0].result.confirmed_bug, false);
  assert.equal(report.reproductions[0].source_action_id, sourceAction.action_id);
  assert.equal(report.reproductions[0].source_run_id, original.run_id);
  assert.notEqual(report.run.run_id, source.run.run_id);
  assert.notEqual(report.run.config.agent_id, source.run.config.agent_id);
  assert.notEqual(report.run.config.worker_id, source.run.config.worker_id);
  for (const [index, action] of report.actions.entries()) {
    assert.equal(action.spec.replay_source_action_id, source.actions[index].action_id);
    assert.equal(action.spec.prediction.expected_result, source.actions[index].spec.prediction.expected_result);
    assert.equal(action.spec.prediction.source_model_request_id, source.actions[index].spec.prediction.request_id);
    assert.notEqual(action.action_id, source.actions[index].action_id);
    assert.notEqual(action.prediction_id, source.actions[index].prediction_id);
  }
  for (const capture of report.captures) {
    assert.ok(!source.captures.some(c => c.capture_id === capture.capture_id));
    assert.equal(sha256(await getObject(s3, capture.object_key)), capture.sha256);
  }
  for (const artifact of report.artifacts) assert.equal(sha256(await getObject(s3, artifact.object_key)), artifact.sha256);
  const manifest = JSON.parse((await getObject(s3, replay.manifest_key)).toString());
  assert.equal(manifest.reproductions[0].result.outcome, 'reproduced');
  assert.equal(manifest.model_calls.length, 2);
  assert.deepEqual(manifest.actions.map(a => a.action_id), report.actions.map(a => a.action_id));

  const unchanged = await request('/v1/runs/' + original.run_id);
  assert.deepEqual(unchanged.actions, source.actions);
  assert.deepEqual(unchanged.events, source.events);
  assert.equal(unchanged.reproductions[0].replay_run_id, replay.run_id);
  assert.equal(sha256(await getObject(s3, unchanged.run.manifest_key)), sha256(originalManifest));

  const repeated = await run('reproduce', sourceAction.action_id);
  assert.equal(repeated.reused, true);
  assert.equal(repeated.run_id, replay.run_id);
  const reused = await request('/v1/runs/' + replay.run_id);
  assert.deepEqual(reused.model_calls, report.model_calls);
  assert.deepEqual(reused.actions, report.actions);
  assert.deepEqual(reused.events, report.events);

  // Model payloads export asynchronously; waiting must never repeat inference.
  let exported = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    const requests = await Promise.all(report.model_requests.map(r => request('/v1/model-requests/' + r.request_id)));
    if (requests.every(r => r.payloads.length === 2 && r.payloads.every(p => p.uploaded_at) && r.events.every(e => e.exported_at))) {
      for (const r of requests) for (const payload of r.payloads) assert.equal(sha256(await getObject(s3, payload.object_key)), payload.sha256);
      exported = true;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(exported, 'Reproduction model payloads and events must export.');
  const telemetry = JSON.parse(await clickhouse(`SELECT count() AS total, countIf(event_type LIKE 'reproduction.%') AS reproduction
    FROM scout.runtime_events_current WHERE run_id=${sqlString(replay.run_id)} FORMAT JSONEachRow`));
  assert.equal(Number(telemetry.total), report.events.length);
  assert.equal(Number(telemetry.reproduction), 2);

  const result = { status: 'passed', verified_at: new Date().toISOString(), mode: 'simulated_model_real_browser',
    source_run_id: original.run_id, source_action_id: sourceAction.action_id, ...replay,
    checks: ['CLI_fresh_replay', 'Rust_API_lineage', 'distinct_evidence_IDs', 'frozen_expectations', 'unchanged_source',
      'idempotent_reuse', 'capture_and_artifact_hashes', 'model_payload_hashes', 'token_totals', 'ClickHouse_export', 'manifest_lineage'] };
  await mkdir(new URL('../artifacts/reproduction/', import.meta.url), { recursive: true });
  await writeFile(new URL('../artifacts/reproduction/verification.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ status: result.status, run_id: replay.run_id, source_action_id: sourceAction.action_id,
    outcome: 'reproduced', actions: replay.actions, captures: replay.captures, model_requests: 2, confirmed_bug: false }, null, 2));
} finally { s3.destroy(); }
