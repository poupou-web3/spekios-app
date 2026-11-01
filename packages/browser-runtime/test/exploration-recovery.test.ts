import test from 'node:test';
import assert from 'node:assert/strict';
import { ExplorationRecovery } from '../src/exploration-recovery.js';

test('drift is bounded per page, including interleaved failures on other pages', () => {
  const recovery = new ExplorationRecovery();
  assert.deepEqual(recovery.replan('/a'), { consecutive: 1, defer: false });
  assert.deepEqual(recovery.replan('/b'), { consecutive: 1, defer: false });
  assert.deepEqual(recovery.replan('/a'), { consecutive: 2, defer: false });
  assert.deepEqual(recovery.replan('/a'), { consecutive: 3, defer: true });
});

test('settled progress resets the failure streak instead of accumulating a run-wide stop', () => {
  const recovery = new ExplorationRecovery();
  for (let i = 0; i < 6; i++) {
    assert.equal(recovery.replan('/a').defer, false);
    assert.equal(recovery.replan('/a').defer, false);
    recovery.progressed();
  }
});
