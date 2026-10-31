import test from 'node:test';
import assert from 'node:assert/strict';
import { browserSlots } from '../src/browser-sandbox.js';
import { BUDGET_USED, CANCELLED, CLAIM_CANDIDATE, CONTINUATION_LIMIT, INTERRUPTED, continuation } from '../src/job-queue.js';

const explore = { kind: 'explore', resumes: 0, runId: 'run', cancelId: null, maxActions: 20 };

test('queued work is claimed from every member, one row at a time', () => {
  assert.match(CLAIM_CANDIDATE, /FOR UPDATE SKIP LOCKED/);
  assert.doesNotMatch(CLAIM_CANDIDATE, /owner_user_id|user_id=\$/);
});

test('an interrupted exploration continues until its budget or three continuations are used', () => {
  assert.equal(continuation(explore, 4, 0).kind, 'resume');
  assert.equal(continuation({ ...explore, runId: null }, 0, 0).kind, 'requeue');
  assert.equal(continuation(explore, 0, 0).kind, 'requeue', 'A run that dispatched nothing is started again.');
  assert.equal(continuation({ ...explore, resumes: 2 }, 0, 8).kind, 'requeue');
  assert.deepEqual(continuation({ ...explore, resumes: 3 }, 0, 8), { kind: 'finish', status: 'interrupted', error: CONTINUATION_LIMIT });
  assert.deepEqual(continuation({ ...explore, resumes: 3 }, 2, 8), { kind: 'finish', status: 'interrupted', error: CONTINUATION_LIMIT });
  assert.deepEqual(continuation(explore, 5, 15), { kind: 'finish', status: 'interrupted', error: BUDGET_USED });
  assert.deepEqual(continuation({ ...explore, kind: 'reproduce' }, 2, 0), { kind: 'finish', status: 'interrupted', error: INTERRUPTED });
  assert.deepEqual(continuation({ ...explore, kind: 'verify_fix' }, 1, 0), { kind: 'finish', status: 'interrupted', error: INTERRUPTED });
  assert.deepEqual(continuation({ ...explore, cancelId: 'cancel' }, 3, 0), { kind: 'finish', status: 'cancelled', error: CANCELLED });
});

test('browser slots are an integer from 1 to 8', () => {
  const previous = process.env.SCOUT_BROWSER_SLOTS;
  try {
    delete process.env.SCOUT_BROWSER_SLOTS;
    assert.equal(browserSlots(), 1);
    process.env.SCOUT_BROWSER_SLOTS = '3';
    assert.equal(browserSlots(), 3);
    process.env.SCOUT_BROWSER_SLOTS = '0';
    assert.throws(() => browserSlots(), /1 to 8/);
  } finally {
    if (previous === undefined) delete process.env.SCOUT_BROWSER_SLOTS;
    else process.env.SCOUT_BROWSER_SLOTS = previous;
  }
});
