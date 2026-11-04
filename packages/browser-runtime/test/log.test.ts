import test from 'node:test';
import assert from 'node:assert/strict';
import { enableProcessLog, eventFields, eventLevel, log } from '../src/log.js';

function capture(body: () => void) {
  const lines: string[] = [];
  const write = process.stdout.write;
  process.stdout.write = ((chunk: string) => { lines.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try { body(); } finally { process.stdout.write = write; }
  return lines;
}

test('process log lines stay off until the worker enables them', () => {
  enableProcessLog(false);
  assert.deepEqual(capture(() => log('info', 'job_started', { job_id: 'a' })), []);
  enableProcessLog();
  const [line] = capture(() => log('warning', 'job_finished', { job_id: 'a', run_id: null, status: 'failed', elapsed_ms: 12, skipped: undefined }));
  enableProcessLog(false);
  assert.ok(line.endsWith('\n') && !line.slice(0, -1).includes('\n'));
  assert.deepEqual(JSON.parse(line), { level: 'warning', msg: 'job_finished', job_id: 'a', status: 'failed', elapsed_ms: 12 });
});

test('runtime event lines copy machine tokens and never free text or URLs', () => {
  const fields = eventFields({
    kind: 'assessment', request_id: '0b6f4c53-6d3d-4a0e-9a59-3c7f5f0f6a11', executed_actions: 7, coverage_complete: false,
    model_tier: 'muse-spark-1.3', stop_reason: 'Nothing new left on https://shop.test/cart', reason: 'token=secret value',
    target_url: 'https://shop.test/?token=secret', error: 'Catalogue render failure', prompt: 'click', control_id: 'add-to-cart',
    assessment: { verdict: 'suspect', explanation: 'The total did not change.' },
  });
  assert.deepEqual(fields, { kind: 'assessment', request_id: '0b6f4c53-6d3d-4a0e-9a59-3c7f5f0f6a11', model_tier: 'muse-spark-1.3',
    executed_actions: 7, coverage_complete: false, verdict: 'suspect' });
  assert.deepEqual(eventFields(null), {});
  assert.deepEqual(eventFields('text'), {});
});

test('runtime event levels flag failures and quiet the frequent evidence events', () => {
  assert.equal(eventLevel('run.failed'), 'error');
  assert.equal(eventLevel('action.evidence_failed'), 'warning');
  assert.equal(eventLevel('reproduction.interrupted'), 'warning');
  assert.equal(eventLevel('computer.recovery_unavailable'), 'warning');
  assert.equal(eventLevel('action.settling_frame'), 'debug');
  assert.equal(eventLevel('model.decision_requested'), 'info');
});
