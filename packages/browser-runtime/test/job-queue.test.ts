import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { browserSlots } from '../src/browser-sandbox.js';
import { CANCELLED, CLAIM_CANDIDATE, INTERRUPTED, abandonJob, jobLock, recoverAbandoned, resumeBudget } from '../src/job-queue.js';
import { Store } from '../src/store.js';
import { workspaceId, userId } from '../src/contracts.js';

test('queued work is claimed from every member, one row at a time', () => {
  assert.match(CLAIM_CANDIDATE, /FOR UPDATE SKIP LOCKED/);
  assert.doesNotMatch(CLAIM_CANDIDATE, /owner_user_id|user_id=\$/);
});

test('a requested continuation spends a new limit and legacy continuations keep the remaining budget', () => {
  assert.deepEqual(resumeBudget({ continueFrom: true, maxActions: 20 }, 18), { maxActions: 20, carriedActions: 0 });
  assert.deepEqual(resumeBudget({ continueFrom: true, maxActions: null }, 400), { maxActions: null, carriedActions: 0 });
  assert.deepEqual(resumeBudget({ maxActions: 20 }, 18), { maxActions: 2, carriedActions: 18 });
  assert.deepEqual(resumeBudget({ maxActions: null }, 400), { maxActions: null, carriedActions: 400 });
  assert.deepEqual(resumeBudget({ maxActions: 20 }, 20), { stop: true });
});

test('worker recovery finishes abandoned jobs without automatically starting a new run', {
  skip: process.env.SCOUT_EXPLORER_INTEGRATION !== '1', timeout: 60000,
}, async t => {
  const store = await new Store().open();
  const owner = await store.session();
  const jobs: string[] = [], runs: string[] = [], published: string[] = [];
  // Exercise real database recovery; manifest upload is covered by the workspace suite.
  store.publish = async runId => {
    published.push(runId);
    return { artifact_id: randomUUID(), object_key: 'queue-test/manifest.json', sha256: '0'.repeat(64), byte_length: 0, kind: 'run_manifest' };
  };
  const create = async ({ kind = 'explore', run = true, dispatched = false, cancelled = false, status = 'running' } = {}) => {
    const jobId = randomUUID(), runId = run ? randomUUID() : null;
    jobs.push(jobId);
    if (runId) {
      runs.push(runId);
      await store.query("INSERT INTO runtime_runs(run_id,workspace_id,user_id,target_url,lifecycle,config,cancel_id) VALUES($1,$2,$3,'https://example.test/','active','{}',$4)",
        [runId, workspaceId, userId, cancelled ? randomUUID() : null]);
      if (dispatched) await store.query(`INSERT INTO runtime_actions(action_id,run_id,ordinal,prediction_id,spec,state,dispatched_at)
        VALUES($1,$2,1,$3,'{"prediction":{"source":"fixture_defined","expected":{"kind":"text_equals","value":"done"}}}','dispatched',now())`,
        [randomUUID(), runId, randomUUID()]);
    }
    await store.query(`INSERT INTO browser_jobs(job_id,workspace_id,user_id,request,settings,execution_mode,status,run_id,cancel_id)
      VALUES($1,$2,$3,$4,'{"maxActions":null}','protocol_fixture',$5,$6,$7)`,
      [jobId, workspaceId, userId, { kind }, status, runId, cancelled ? randomUUID() : null]);
    return { jobId, runId };
  };
  const read = async (id: string) => (await store.query('SELECT * FROM browser_jobs WHERE job_id=$1', [id])).rows[0];
  try {
    for (const scenario of [
      { name: 'before a run exists', run: false },
      { name: 'before the first browser action' },
      { name: 'after dispatch with an unlimited budget', dispatched: true },
      { name: 'during reproduction', kind: 'reproduce', dispatched: true },
      { name: 'during fix verification', kind: 'verify_fix', dispatched: true },
      { name: 'with cancellation pending', cancelled: true, dispatched: true },
      { name: 'with cancellation before a run exists', cancelled: true, run: false },
    ]) await t.test(scenario.name, async () => {
      const { jobId, runId } = await create(scenario);
      await abandonJob(store, jobId);
      const job = await read(jobId);
      assert.equal(job.status, scenario.cancelled ? 'cancelled' : 'interrupted');
      assert.equal(job.error, scenario.cancelled ? CANCELLED : INTERRUPTED);
      assert.equal(job.run_id, runId);
      assert.equal(job.resumes, 0);
      assert.deepEqual(job.previous_run_ids, []);
      assert.ok(job.finished_at);
      if (runId) {
        const report = await store.report(runId);
        assert.equal(report.run.lifecycle, scenario.cancelled ? 'cancelled' : 'failed');
        assert.ok(published.includes(runId));
        if (scenario.dispatched) {
          assert.equal(report.actions.length, 1);
          assert.equal(report.actions[0].assessment.verdict, 'inconclusive');
        }
      }
      const snapshot = await read(jobId);
      await abandonJob(store, jobId);
      assert.deepEqual(await read(jobId), snapshot, 'Repeated recovery leaves the finished job unchanged.');
    });
    await t.test('recovery respects live worker locks and leaves queued work queued', async () => {
      const active = await create({ run: false }), queued = await create({ run: false, status: 'queued' });
      await owner.tryLock(jobLock(active.jobId));
      await recoverAbandoned(store);
      assert.equal((await read(active.jobId)).status, 'running');
      assert.equal((await read(queued.jobId)).status, 'queued');
      await owner.unlock(jobLock(active.jobId));
      await recoverAbandoned(store);
      assert.equal((await read(active.jobId)).status, 'interrupted');
      assert.equal((await read(queued.jobId)).status, 'queued');
    });
  } finally {
    await owner.close();
    await store.query('DELETE FROM browser_jobs WHERE job_id=ANY($1::uuid[])', [jobs]);
    await store.query('DELETE FROM runtime_events WHERE run_id=ANY($1::uuid[])', [runs]);
    await store.query('DELETE FROM runtime_actions WHERE run_id=ANY($1::uuid[])', [runs]);
    await store.query('DELETE FROM runtime_runs WHERE run_id=ANY($1::uuid[])', [runs]);
    await store.close();
  }
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
